/**
 * OpenCode Zen provider for DSH.
 *
 * Why this builds a provider by hand instead of writing `llm-pi-ai` settings:
 * a Zen account spans several wire protocols at once. Measured against the
 * installed pi-ai catalogue, `opencode` describes 73 models across
 * `anthropic-messages`, `openai-responses`, `openai-completions`, and
 * `google-generative-ai`. DSH settings can express only ONE protocol per route
 * (`PiAiProviderProfile.api`, "wire protocol every model on this route speaks"),
 * and a per-model `api` in `models[]` is silently accepted and then ignored. So
 * a settings-declared Zen route can never serve a mixed selection.
 *
 * pi-ai itself has no such limit: `CreateProviderOptions.api` accepts a map
 * keyed by `model.api`, which is exactly how pi-ai's own `opencodeProvider()`
 * works. This module reuses that catalogue and that dispatch, and hands the
 * result to the harness as a ready-made `piProvider` — the same escape hatch
 * the WorkBuddy route already uses.
 *
 * On top of dispatch it applies the free-tier gate shaping
 * ({@link applyZenGateShape}) and the client identity the gate requires, because
 * those cannot be expressed through the harness's own header/body assembly:
 * `dsh-llm-pi-ai` composes headers as `{...attribution, ...profile.headers}`
 * and pi-ai then merges `model.headers` underneath, so the harness attribution
 * `User-Agent` always wins. The final `fetch` is the only point after every
 * merge.
 *
 * @module dsh-coding-subscription-oauth/opencode-zen-provider
 */

import type { Api, Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import {
	applyZenGateShape,
	classifyZenUpstreamError,
	isZenGateToolName,
	OPENCODE_ZEN_CLIENT_VERSION,
	zenGateHeaders,
	zenSessionId,
	zenToolNames,
} from "./opencode-zen-gate.ts";
import { OPENCODE_ZEN_BASE_URL, OPENCODE_ZEN_DISPLAY_NAME, OPENCODE_ZEN_PROVIDER_ID } from "./opencode-zen-ids.ts";

export { OPENCODE_ZEN_DISPLAY_NAME };

/** Stream idle timeout; a long Zen answer can prefill for a while. */
export const OPENCODE_ZEN_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Image budget policy shared with the other subscription routes. */
export const OPENCODE_ZEN_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20 * 1024 * 1024,
	requestImagePixelBudget: 40_000_000,
	requestImageMaxBytes: 4 * 1024 * 1024,
} as const;

/**
 * Models whose requests must be shaped for the free-tier gate.
 *
 * The gate is NOT global: measured against the live endpoint, paid models such
 * as `deepseek-v4-pro` and `claude-opus-5-5` answer a plain request, while the
 * `-free` models refuse anything that does not look like the official client.
 * Shaping is therefore scoped by model id so a paid model's request is never
 * given tools it did not ask for — which matters, because the gate's required
 * roster includes tool names the harness cannot execute.
 */
const FREE_TIER_SUFFIX = /-free$/u;

/** True when this model needs the official-client shape to be admitted. */
export function zenModelRequiresGate(modelId: string): boolean {
	return FREE_TIER_SUFFIX.test(modelId) || modelId === "exo-free";
}

/**
 * Re-stamp one catalogue model onto this plugin's route.
 *
 * Only identity changes: the catalogue's own `api`, `baseUrl`, `compat`,
 * thinking map, cost, and capabilities are preserved, because they are the
 * vendor's own published facts and this plugin has nothing better to say.
 */
export function zenModel(model: Model<Api>, providerId: string = OPENCODE_ZEN_PROVIDER_ID): Model<Api> {
	return {
		...model,
		provider: providerId,
		baseUrl: model.baseUrl ?? OPENCODE_ZEN_BASE_URL,
	};
}

/**
 * The models this route serves.
 *
 * Sourced from pi-ai's installed `opencode` catalogue, which is refreshed with
 * pi-ai itself, so a Zen model addition reaches users through a pi-ai upgrade
 * rather than a plugin release. `filter` narrows the served set to the ids the
 * operator enabled in the settings card; an empty filter serves the whole
 * catalogue, matching the WorkBuddy route's "no selection means everything".
 */
export function zenModels(filter?: (modelId: string) => boolean, providerId?: string): Model<Api>[] {
	const all = opencodeProvider().getModels();
	const selected = filter === undefined ? all : all.filter((model) => filter(model.id));
	return selected.map((model) => zenModel(model, providerId));
}

/**
 * A one-sentence explanation for why the gate refused a body, or `undefined`
 * when the body is already acceptable. Used by diagnostics and tests.
 */
export function zenGateDeficiency(body: Record<string, unknown>): string | undefined {
	if (body["stream"] !== true) return "the gate requires stream:true";
	const names = zenToolNames(body);
	if (names.length < 2) return `the gate requires at least two tools, got ${names.length}`;
	if (!names.some((name) => isZenGateToolName(name) && name !== "read")) return "the gate requires a bash/shell tool";
	if (!names.includes("read")) return "the gate requires a read tool";
	return undefined;
}

/**
 * Wrap a provider so every outbound request carries the client identity the
 * free-tier gate requires and is shaped to pass it.
 *
 * The wrapper is applied per request rather than baked into the model, so a
 * session id is fresh for each call (the gate accepts a shape, but reusing one
 * id across every request in a session would defeat the per-conversation
 * routing the header exists for).
 *
 * Both `stream` and `streamSimple` are wrapped. Body shaping happens in
 * `onPayload`, which pi-ai invokes after it has built the request body and
 * before the transport, and header/`fetch` shaping happens in the transport
 * override — the only order in which the harness's own header merge cannot
 * overwrite the identity.
 */
export function withZenGate<P extends Provider>(provider: P): P {
	const sessionId = zenSessionId();
	const identity = zenGateHeaders({ session: sessionId });
	const streams = provider as unknown as ProviderStreams;
	return {
		...provider,
		stream: (model, context, options) =>
			streams.stream(model, context, shapeOptions(model, options as Record<string, unknown> | undefined, identity)),
		streamSimple: (model, context, options) =>
			streams.streamSimple(
				model,
				context,
				shapeOptions(model, options as Record<string, unknown> | undefined, identity) as never,
			),
	} as P;
}

/**
 * Attach the gate identity and, for free-tier models, the body transformation.
 *
 * `onPayload` is composed with any caller-supplied hook rather than replacing
 * it, so a harness hook still sees — and can still edit — the shaped body.
 */
function shapeOptions(
	model: Model<Api>,
	options: Record<string, unknown> | undefined,
	identity: Record<string, string>,
): Record<string, unknown> {
	const needsGate = zenModelRequiresGate(model.id);
	const callerHook = options?.["onPayload"] as ((payload: unknown, model: unknown) => unknown) | undefined;
	const next: Record<string, unknown> = {
		...options,
		fetch: zenFetch(options?.["fetch"], identity, model.id),
	};
	if (!needsGate) return next;
	next["onPayload"] = (payload: unknown, payloadModel: unknown) => {
		const shaped = shapeZenPayload(payload, model.id);
		return callerHook === undefined ? shaped : callerHook(shaped, payloadModel);
	};
	return next;
}

/** Shape one JSON payload for the gate; non-object payloads pass through. */
export function shapeZenPayload(payload: unknown, modelId: string): unknown {
	if (payload === undefined || payload === null || typeof payload !== "object") return payload;
	if (!zenModelRequiresGate(modelId)) return payload;
	const original = payload as Record<string, unknown>;
	// `tool_choice`/`tools` only exist on the chat-shaped protocols. The
	// Anthropic and Responses bodies carry tools too, but under their own keys,
	// and the gate reads them the same way.
	const deficient = zenGateDeficiency(original) !== undefined;
	if (!deficient) return original;
	return applyZenGateShape(original);
}

/**
 * Force the client identity onto the wire.
 *
 * `Authorization` is deliberately left alone: the harness resolves the
 * credential and injects the bearer, and the gate is a separate concern from
 * authentication. Only the client-fingerprint headers are overridden.
 *
 * Any `fetch` the caller supplied is preserved as the transport, so this
 * composes with the harness rather than bypassing it.
 */
function zenFetch(inner: unknown, identity: Record<string, string>, modelId: string): typeof fetch {
	void modelId;
	const base = typeof inner === "function" ? (inner as typeof fetch) : fetch;
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const headers = new Headers(init?.headers);
		for (const [key, value] of Object.entries(identity)) headers.set(key, value);
		if (process.env["OPENCODE_ZEN_WIRE_DUMP"] !== undefined) {
			const dump: Record<string, string> = {};
			headers.forEach((value, key) => {
				dump[key] = key.toLowerCase() === "authorization" ? "Bearer <redacted>" : value;
			});
		}
		const response = await base(input, { ...init, headers });
		if (response.status >= 400) {
			// Re-fingerprint on the next call: a rejected id should not be reused.
			const next = zenGateHeaders();
			for (const [key, value] of Object.entries(next)) identity[key] = value;
			identity["User-Agent"] = OPENCODE_ZEN_CLIENT_VERSION;
		}
		return response;
	}) as typeof fetch;
}

/**
 * Build the plugin's OpenCode Zen provider.
 *
 * `models` is a live closure because the enabled set is card state: enabling a
 * model must reach the next catalogue read without rebuilding the route.
 */
export function opencodeZenProvider(options: { models: () => readonly Model<Api>[] }): Provider {
	const base = createProvider({
		id: OPENCODE_ZEN_PROVIDER_ID,
		name: OPENCODE_ZEN_DISPLAY_NAME,
		baseUrl: OPENCODE_ZEN_BASE_URL,
		auth: {
			apiKey: {
				name: "OpenCode Zen API key",
				resolve: async ({ credential }) => {
					const apiKey = credential?.key;
					return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "OpenCode Zen" };
				},
			},
		},
		models: [...options.models()],
		// The api map is the whole point: dispatch is per model, so one route
		// serves every protocol a Zen account spans.
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleGenerativeAIApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		} as unknown as ProviderStreams,
	});
	const wrapped = withZenGate(base as unknown as Provider);
	return { ...wrapped, getModels: () => [...options.models()] };
}

/** Re-exported so the connection controller reports the same failure codes. */
export { classifyZenUpstreamError };
