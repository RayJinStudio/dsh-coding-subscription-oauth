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
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { classifyZenUpstreamError } from "./opencode-zen-gate.js";
import { OPENCODE_ZEN_DISPLAY_NAME } from "./opencode-zen-ids.js";
export { OPENCODE_ZEN_DISPLAY_NAME };
/** Stream idle timeout; a long Zen answer can prefill for a while. */
export declare const OPENCODE_ZEN_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Image budget policy shared with the other subscription routes. */
export declare const OPENCODE_ZEN_IMAGE_BUDGETS: {
    readonly maxRequestImageBytes: number;
    readonly requestImagePixelBudget: 40000000;
    readonly requestImageMaxBytes: number;
};
/** True when this model needs the official-client shape to be admitted. */
export declare function zenModelRequiresGate(modelId: string): boolean;
/**
 * Re-stamp one catalogue model onto this plugin's route.
 *
 * Only identity changes: the catalogue's own `api`, `baseUrl`, `compat`,
 * thinking map, cost, and capabilities are preserved, because they are the
 * vendor's own published facts and this plugin has nothing better to say.
 */
export declare function zenModel(model: Model<Api>, providerId?: string): Model<Api>;
/**
 * The models this route serves.
 *
 * Sourced from pi-ai's installed `opencode` catalogue, which is refreshed with
 * pi-ai itself, so a Zen model addition reaches users through a pi-ai upgrade
 * rather than a plugin release. `filter` narrows the served set to the ids the
 * operator enabled in the settings card; an empty filter serves the whole
 * catalogue, matching the WorkBuddy route's "no selection means everything".
 */
export declare function zenModels(filter?: (modelId: string) => boolean, providerId?: string): Model<Api>[];
/**
 * A one-sentence explanation for why the gate refused a body, or `undefined`
 * when the body is already acceptable. Used by diagnostics and tests.
 */
export declare function zenGateDeficiency(body: Record<string, unknown>): string | undefined;
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
export declare function withZenGate<P extends Provider>(provider: P): P;
/** Shape one JSON payload for the gate; non-object payloads pass through. */
export declare function shapeZenPayload(payload: unknown, modelId: string): unknown;
/**
 * Build the plugin's OpenCode Zen provider.
 *
 * `models` is a live closure because the enabled set is card state: enabling a
 * model must reach the next catalogue read without rebuilding the route.
 */
export declare function opencodeZenProvider(options: {
    models: () => readonly Model<Api>[];
}): Provider;
/** Re-exported so the connection controller reports the same failure codes. */
export { classifyZenUpstreamError };
//# sourceMappingURL=opencode-zen-provider.d.ts.map