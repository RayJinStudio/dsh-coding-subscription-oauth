/**
 * WorkBuddy model catalog, the fixed image-modality policy, and the pi-ai
 * provider that serves the route.
 *
 * ## Why this provider does not need a local shim
 *
 * The reference implementation (`dsh-connect-workbuddy`) runs a loopback HTTP
 * shim because `dsh-llm-pi-ai` never forwards pi-ai's per-request `fetch` and
 * `onPayload` hooks, so a settings-only provider has no way to rewrite the
 * request body. That is true of the *settings* provider shape — but not of this
 * one: the harness hands the stream to the provider object itself, so wrapping
 * the provider's own `streamSimple` is enough to inject those hooks. Verified
 * against pi-ai 0.87.1 (`dist/api/simple-options.js:26` copies `onPayload`;
 * `dist/api/openai-completions.js:186-191` honours it) and against
 * `dsh-llm-pi-ai` (`lib/index.js:1881` calls `models.streamSimple`).
 *
 * So the wire quirks are applied in-process by {@link withWorkBuddyWire}, and
 * the only WorkBuddy knowledge that reaches the wire is the body normalizer in
 * {@link ./workbuddy-upstream.ts}.
 *
 * ## Image modality is a fixed policy, not a user option
 *
 * The upstream's `supportsImages` is the PLATFORM's image-input declaration, not
 * the model's native capability: on live CN data it is `true` for text-only
 * models such as `glm-5.3` and `glm-5.1`. Adopting it would advertise image
 * input for models that cannot read images. The reviewed table below is the
 * authority and the platform flag only ever VETOES; an id that is not in the
 * table stays text-only rather than inheriting a neighbour's answer.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-provider
 */

import { appendFileSync } from "node:fs";
import type { Api, Model, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { WORKBUDDY_ROUTE } from "./ids.ts";
import {
	prepareWorkBuddyChatBody,
	WORKBUDDY_CLIENT_UA,
	type WorkBuddyModelInfo,
	workbuddyChatBase,
} from "./workbuddy-upstream.ts";

/**
 * pi-ai provider id and harness route for WorkBuddy (one id, like Grok Build).
 *
 * Re-exported from {@link WORKBUDDY_ROUTE} rather than spelled again: the
 * harness keys its adapter profile map by this exact string and pi-ai stamps
 * `model.provider` with it, so the two must never drift. It is deliberately NOT
 * `workbuddy` — the reference plugin `dsh-connect-workbuddy` owns that id (and
 * `workbuddy-global`), and `ctx.llm.registerAdapter` is all-or-nothing, so
 * sharing it would make the two plugins mutually exclusive.
 */
export const WORKBUDDY_PI_PROVIDER = WORKBUDDY_ROUTE;

/**
 * Display name shown above the model list.
 *
 * Not plain "WorkBuddy": the reference plugin can be installed alongside this
 * one and already labels its routes "WorkBuddy" / "WorkBuddy Global", so two
 * identically named providers would be indistinguishable in the model picker.
 * The suffix matches this plugin's route id.
 */
export const WORKBUDDY_DISPLAY_NAME = "WorkBuddy (OAuth)";

/** Stream idle timeout; a long WorkBuddy answer can prefill for a while. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Image budget policy shared with the other OAuth routes. */
export const WORKBUDDY_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20 * 1024 * 1024,
	requestImagePixelBudget: 2048 * 2048,
	requestImageMaxBytes: 1024 * 1024,
} as const;

/** Zeroed cost: a subscription is not billed per token by this plugin. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Documented native input modality for one exact model id.
 *
 * Only two states are recorded, because only two are ever confirmed: an id is
 * either documented `multimodal` or documented `text`. Everything else —
 * including a brand-new model — is unclassified and MUST stay text-only rather
 * than inheriting a family answer or the platform's image flag.
 *
 * Snapshot from `dsh-connect-workbuddy`'s reviewed table (entries reviewed
 * 2026-09-25), extended with the ids this plugin's live CN probe returned.
 */
export const WORKBUDDY_NATIVE_MODALITY: Readonly<Record<string, "text" | "multimodal">> = {
	// ── Documented text-only ──
	"deepseek-v4-pro": "text",
	"deepseek-v3-2-volc": "text",
	"glm-5.1": "text",
	"glm-5.2": "text",
	"glm-5.3": "text",
	"glm-5.0": "text",
	"glm-5.0-turbo": "text",
	"glm-4.7": "text",
	"glm-4.6": "text",
	hy3: "text",
	"hy3-x": "text",
	"hy4-preview": "text",
	"hunyuan-chat": "text",
	"minimax-m2.5": "text",
	"kimi-k2-thinking": "text",
	default: "text",
	// ── Documented native multimodal ──
	"deepseek-v4.1-flash": "multimodal",
	"glm-5.3-flash": "multimodal",
	"glm-5v-turbo": "multimodal",
	"glm-4.6v": "multimodal",
	"kimi-k2.5": "multimodal",
	"kimi-k2.6": "multimodal",
	"kimi-k2.7": "multimodal",
	"kimi-k2.8-preview": "multimodal",
	"kimi-k3-1": "multimodal",
	"minimax-m2.7": "multimodal",
	"minimax-m3": "multimodal",
	"space-bunny": "multimodal",
};

/**
 * Whether one model takes image input under the fixed policy.
 *
 * The reviewed table decides; a platform `supportsImages: false` still vetoes,
 * and an unclassified id is text-only.
 */
export function workbuddyModelTakesImages(info: Pick<WorkBuddyModelInfo, "id" | "supportsImages">): boolean {
	if (info.supportsImages === false) return false;
	return WORKBUDDY_NATIVE_MODALITY[info.id] === "multimodal";
}

/** pi-ai levels, in the order the map is built. */
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Translate WorkBuddy reasoning metadata into a pi-ai thinking map.
 *
 * `off` is always `null`, meaning "supported, send nothing": the gateway thinks
 * not at all when no `reasoning_effort` is present. Every other level is mapped
 * to its own wire spelling when the model declares it and pinned to `null`
 * otherwise — pi-ai treats an absent key as supported, so an undeclared level
 * must be stated explicitly rather than omitted.
 */
export function workbuddyThinkingLevelMap(info: WorkBuddyModelInfo): ThinkingLevelMap | undefined {
	const declared = info.reasoning?.supportedEfforts ?? [];
	const offered = new Set(declared);
	if (offered.size === 0 && info.reasoning?.defaultEffort === undefined) return undefined;
	const map: ThinkingLevelMap = { off: null };
	let any = false;
	for (const level of PI_LEVELS) {
		const supported = offered.has(level);
		map[level] = supported ? level : null;
		if (supported) any = true;
	}
	// A model that declares only a default effort still offers that one level.
	const onlyDefault = info.reasoning?.defaultEffort;
	if (!any && onlyDefault !== undefined && (PI_LEVELS as readonly string[]).includes(onlyDefault)) {
		map[onlyDefault as (typeof PI_LEVELS)[number]] = onlyDefault;
		any = true;
	}
	return any ? map : undefined;
}

/**
 * The header identity stated on `profile.headers` for every WorkBuddy request.
 *
 * `dsh-llm-pi-ai` builds each request as
 * `{ ...attributionHeaders(), ...profile.headers }`, and pi-ai then merges
 * `model.headers` UNDER that result. A `User-Agent` set only on the model is
 * therefore always overwritten by the harness attribution UA
 * (`deepseek-harness/…`), and the gateway answers business code `11128`
 * ("this call failed channel verification, possibly because it was not sent from
 * an official client"). Stating the CLI identity here is what fixes it — the same
 * mechanism Grok uses via `grokBuildFingerprintHeaders()`.
 *
 * Only credential-INdependent fields are here. `X-User-Id` / `X-Domain` stay on
 * the model so a per-account switch still reaches the wire, and the bearer is
 * supplied by the adapter's apiKey resolver. No token is ever placed in a profile
 * object, which outlives a single request.
 */
export function workbuddyWireFingerprintHeaders(): Record<string, string> {
	return {
		"User-Agent": WORKBUDDY_CLIENT_UA,
		Accept: "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"X-Product": "SaaS",
	};
}

/** Static CLI roster captured from the live CN gateway (`/v3/config`, cli agent). */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
	{ id: "hy4-preview-f", name: "Hy4 preview", contextWindow: 960_000, maxTokens: 64_000, creditMultiplier: 0 },
	{ id: "hy3", name: "Hy3", contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0 },
	{ id: "hy3-x", name: "Hy3 x", contextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0.05 },
	{ id: "space-bunny", name: "Space Bunny", contextWindow: 1_000_000, maxTokens: 128_000, creditMultiplier: 0.03 },
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		creditMultiplier: 0.11,
	},
	{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0.79 },
	{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1_000_000, maxTokens: 131_072, creditMultiplier: 0.06 },
	{ id: "glm-5.2", name: "GLM-5.2", contextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0.79 },
	{ id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, maxTokens: 48_000, creditMultiplier: 0.79 },
	{ id: "glm-5v-turbo", name: "GLM-5v-Turbo", contextWindow: 200_000, maxTokens: 64_000, creditMultiplier: 0.71 },
	{ id: "minimax-m3", name: "MiniMax-M3", contextWindow: 512_000, maxTokens: 64_000, creditMultiplier: 0.25 },
	{ id: "minimax-m2.7", name: "MiniMax-M2.7", contextWindow: 200_000, maxTokens: 48_000, creditMultiplier: 0.19 },
	{ id: "kimi-k3-1", name: "Kimi-K3", contextWindow: 1_000_000, maxTokens: 32_000, creditMultiplier: 1.62 },
	{
		id: "kimi-k2.8-preview",
		name: "Kimi-K2.8-Preview",
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		creditMultiplier: 0.77,
	},
	{ id: "kimi-k2.7", name: "Kimi-K2.7-Code", contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.57 },
	{ id: "kimi-k2.6", name: "Kimi-K2.6", contextWindow: 256_000, maxTokens: 32_000, creditMultiplier: 0.52 },
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		creditMultiplier: 0.51,
	},
];

/** Display name, including the credit rate when the upstream declared one. */
export function workbuddyDisplayName(info: WorkBuddyModelInfo): string {
	const multiplier = info.creditMultiplier;
	if (multiplier === undefined) return info.name;
	// A zero rate is the upstream's own "free now" spelling and reads better as
	// words than as "x0.00".
	return multiplier === 0 ? `${info.name} · free` : `${info.name} · x${multiplier}`;
}

/** Build one pi-ai model descriptor for the WorkBuddy route. */
export function workbuddyPiModel(
	info: WorkBuddyModelInfo,
	baseUrl: string,
	headers: Record<string, string> = {},
): Model<Api> {
	const thinkingLevelMap = workbuddyThinkingLevelMap(info);
	return {
		id: info.id,
		name: workbuddyDisplayName(info),
		api: "openai-completions",
		provider: WORKBUDDY_PI_PROVIDER,
		baseUrl,
		input: workbuddyModelTakesImages(info) ? ["text", "image"] : ["text"],
		cost: { ...NO_COST },
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		reasoning: thinkingLevelMap !== undefined,
		...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
		// WorkBuddy's CLI-shaped headers are credential-dependent, so they ride on
		// the model: pi-ai merges `{User-Agent, ...model.headers}` and a live
		// `getModels` closure re-reads the credential on every catalog read.
		...(Object.keys(headers).length === 0 ? {} : { headers }),
		compat: {
			// The gateway rejects OpenAI's newer `developer` role with business code
			// 11128. pi-ai would otherwise emit it: its detector returns
			// `supportsDeveloperRole: true` for any non-OpenRouter base URL.
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: thinkingLevelMap !== undefined,
		},
	} as unknown as Model<Api>;
}

/** Stream methods a provider exposes, minimally typed for the wrapper. */
interface WorkBuddyStreamableProvider {
	readonly id: string;
	stream: (model: never, context: never, options?: never) => unknown;
	streamSimple: (model: never, context: never, options?: never) => unknown;
}

/** The `onPayload` shape pi-ai accepts. */
type WorkBuddyOnPayload = (payload: unknown, model: unknown) => unknown | undefined | Promise<unknown | undefined>;

interface WorkBuddyStreamOptions {
	onPayload?: WorkBuddyOnPayload;
	[key: string]: unknown;
}

/**
 * Wrap a provider so every request is made gateway-shaped: the body is
 * normalized for the gateway and the client identity is forced onto the wire.
 *
 * One hook serves both concerns. `dsh-llm-pi-ai` forwards no `onPayload`, but it
 * does dispatch the stream through the provider object, so injecting the hook
 * here puts it back in front of pi-ai's request builder.
 *
 * The `fetch` wrapper is not a diagnostic detail — it is the fix for the channel
 * check. `dsh-llm-pi-ai` composes request headers as
 * `{ ...attributionHeaders(), ...profile.headers }` and pi-ai then merges
 * `model.headers` underneath that result, so a `User-Agent` supplied by a model
 * is always replaced by the harness attribution UA
 * (`deepseek-harness/…`). The gateway rejects that with business code `11128`
 * ("this call failed channel verification, possibly because it was not sent from
 * an official client"). Only the final `fetch` call is after every merge, so only
 * there can the official CLI identity be guaranteed. It is applied per request
 * rather than baked into the model, so an account switch still re-derives it.
 *
 * When `WORKBUDDY_WIRE_DUMP` is set, the exact outbound body, headers and the raw
 * upstream response for any 4xx are appended to that file. This exists because the
 * OpenAI SDK renders a business 400 as `400 status code (no body)`, hiding the
 * gateway's own `code`/`msg`. Gated on the variable because the dump contains the
 * full prompt.
 */
export function withWorkBuddyWire<P extends WorkBuddyStreamableProvider>(
	provider: P,
): Omit<P, "stream" | "streamSimple"> & WorkBuddyStreamableProvider {
	const normalize: WorkBuddyOnPayload = (payload) => {
		if (payload === undefined || payload === null) return payload;
		return JSON.parse(prepareWorkBuddyChatBody(JSON.stringify(payload))) as unknown;
	};
	const forward =
		(method: "stream" | "streamSimple") => (model: never, context: never, options?: WorkBuddyStreamOptions) => {
			const callerHook = options?.onPayload;
			const onPayload: WorkBuddyOnPayload = async (payload, m) => {
				const normalized = normalize(payload, m);
				dumpWire({
					kind: "request",
					method,
					model: (m as { id?: string } | undefined)?.id,
					body: JSON.stringify(normalized),
				});
				return callerHook === undefined ? normalized : callerHook(normalized, m);
			};
			return (provider[method] as unknown as (a: never, b: never, c: unknown) => unknown)(model, context, {
				...options,
				onPayload,
				fetch: gatewayFetch(options?.["fetch"]),
			});
		};
	return {
		...provider,
		stream: forward("stream"),
		streamSimple: forward("streamSimple"),
	} as unknown as Omit<P, "stream" | "streamSimple"> & WorkBuddyStreamableProvider;
}

/** The diagnostic path, or undefined when dumping is off. */
function dumpFile(): string | undefined {
	const file = process.env["WORKBUDDY_WIRE_DUMP"];
	return file === undefined || file.trim() === "" ? undefined : file.trim();
}

/**
 * Force the official-client identity onto the wire, and record diagnostics.
 *
 * This is the LAST point before the network, i.e. after `dsh-llm-pi-ai`'s
 * `attributionHeaders()` merge and pi-ai's own header assembly — so it is the only
 * place a `User-Agent` is guaranteed to survive. Getting the identity wrong is not
 * cosmetic: the gateway answers business code `11128` ("this call failed channel
 * verification, possibly because it was not sent from an official client") and the
 * OpenAI SDK then renders it as the opaque `400 status code (no body)`.
 *
 * `Authorization` and the credential-dependent `X-User-Id` / `X-Domain` /
 * `X-*` sentinels are left exactly as pi-ai and the model set them; only the
 * client identity is overridden.
 *
 * Any `fetch` the caller already supplied is preserved and used as the transport,
 * so this composes with a harness-provided implementation instead of bypassing it.
 */
function gatewayFetch(inner: unknown): typeof fetch {
	const base = typeof inner === "function" ? (inner as typeof fetch) : fetch;
	const identity = workbuddyWireFingerprintHeaders();
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const headers = new Headers(init?.headers);
		for (const [key, value] of Object.entries(identity)) headers.set(key, value);
		const next: Parameters<typeof fetch>[1] = { ...init, headers };
		// Record the headers too: a 11128 channel rejection is decided by them, not by
		// the body, so the header set is the evidence that matters.
		if (dumpFile() !== undefined) {
			try {
				const record: Record<string, string> = {};
				headers.forEach((value, key) => {
					record[key] = key.toLowerCase() === "authorization" ? "Bearer <redacted>" : value;
				});
				dumpWire({ kind: "wire-headers", url: String(input), headers: record });
			} catch {
				// Diagnostics must not affect the request.
			}
		}
		const response = await base(input, next);
		if (response.status >= 400 && dumpFile() !== undefined) {
			try {
				const text = await response.clone().text();
				dumpWire({
					kind: "response",
					method: "POST",
					status: response.status,
					contentType: response.headers.get("content-type") ?? "",
					body: text.slice(0, 4000),
				});
			} catch {
				// Diagnostics must not affect the request.
			}
		}
		return response;
	}) as typeof fetch;
}

/**
 * Append one diagnostic line to the file named by `WORKBUDDY_WIRE_DUMP`.
 *
 * Best-effort and synchronous: it runs inside the request path, so a failure to
 * write must never change what the request does. Absent the variable this is a
 * single `undefined` check.
 */
function dumpWire(entry: Record<string, unknown>): void {
	const file = dumpFile();
	if (file === undefined) return;
	try {
		appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// Diagnostics must not affect the request.
	}
}

/**
 * Build the WorkBuddy pi-ai provider.
 *
 * The provider carries NO `baseUrl` of its own: the base is per-model, because
 * it depends on the credential's region and a user can switch accounts. That is
 * also why `models` is a live closure — a catalog refresh, a context-budget
 * change or an account switch must reach the next read.
 *
 * Auth is apiKey-shaped: the access token is injected as the bearer key by the
 * surrounding adapter, which refreshes under the store lock before the key ever
 * reaches here.
 */
export function workbuddyProvider(options: { models: () => readonly Model<Api>[] }): Provider {
	const base = createProvider({
		id: WORKBUDDY_PI_PROVIDER,
		name: WORKBUDDY_DISPLAY_NAME,
		auth: {
			apiKey: {
				name: "WorkBuddy access token",
				resolve: async ({ credential }) => {
					const apiKey = credential?.key;
					return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: "WorkBuddy" };
				},
			},
		},
		models: [...options.models()],
		api: { "openai-completions": openAICompletionsApi() },
	});
	const wrapped = withWorkBuddyWire(base as unknown as WorkBuddyStreamableProvider);
	return { ...(wrapped as unknown as Provider), getModels: () => [...options.models()] };
}

/** Re-exported so session/card code can talk about roster rows without a second import site. */
export type { WorkBuddyModelInfo };
/** The chat base URL a credential's region resolves to, for diagnostics. */
export { workbuddyChatBase };
