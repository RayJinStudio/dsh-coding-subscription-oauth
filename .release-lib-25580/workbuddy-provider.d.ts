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
import type { Api, Model, Provider, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { type WorkBuddyModelInfo, workbuddyChatBase } from "./workbuddy-upstream.js";
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
export declare const WORKBUDDY_PI_PROVIDER: "workbuddy-oauth";
/**
 * Display name shown above the model list.
 *
 * Not plain "WorkBuddy": the reference plugin can be installed alongside this
 * one and already labels its routes "WorkBuddy" / "WorkBuddy Global", so two
 * identically named providers would be indistinguishable in the model picker.
 * The suffix matches this plugin's route id.
 */
export declare const WORKBUDDY_DISPLAY_NAME = "WorkBuddy (OAuth)";
/** Stream idle timeout; a long WorkBuddy answer can prefill for a while. */
export declare const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Image budget policy shared with the other OAuth routes. */
export declare const WORKBUDDY_IMAGE_BUDGETS: {
    readonly maxRequestImageBytes: number;
    readonly requestImagePixelBudget: number;
    readonly requestImageMaxBytes: number;
};
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
export declare const WORKBUDDY_NATIVE_MODALITY: Readonly<Record<string, "text" | "multimodal">>;
/**
 * Whether one model takes image input under the fixed policy.
 *
 * The reviewed table decides; a platform `supportsImages: false` still vetoes,
 * and an unclassified id is text-only.
 */
export declare function workbuddyModelTakesImages(info: Pick<WorkBuddyModelInfo, "id" | "supportsImages">): boolean;
/**
 * Translate WorkBuddy reasoning metadata into a pi-ai thinking map.
 *
 * `off` is always `null`, meaning "supported, send nothing": the gateway thinks
 * not at all when no `reasoning_effort` is present. Every other level is mapped
 * to its own wire spelling when the model declares it and pinned to `null`
 * otherwise — pi-ai treats an absent key as supported, so an undeclared level
 * must be stated explicitly rather than omitted.
 */
export declare function workbuddyThinkingLevelMap(info: WorkBuddyModelInfo): ThinkingLevelMap | undefined;
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
export declare function workbuddyWireFingerprintHeaders(): Record<string, string>;
/** Static CLI roster captured from the live CN gateway (`/v3/config`, cli agent). */
export declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/** Display name, including the credit rate when the upstream declared one. */
export declare function workbuddyDisplayName(info: WorkBuddyModelInfo): string;
/** Build one pi-ai model descriptor for the WorkBuddy route. */
export declare function workbuddyPiModel(info: WorkBuddyModelInfo, baseUrl: string, headers?: Record<string, string>): Model<Api>;
/** Stream methods a provider exposes, minimally typed for the wrapper. */
interface WorkBuddyStreamableProvider {
    readonly id: string;
    stream: (model: never, context: never, options?: never) => unknown;
    streamSimple: (model: never, context: never, options?: never) => unknown;
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
export declare function withWorkBuddyWire<P extends WorkBuddyStreamableProvider>(provider: P): Omit<P, "stream" | "streamSimple"> & WorkBuddyStreamableProvider;
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
export declare function workbuddyProvider(options: {
    models: () => readonly Model<Api>[];
}): Provider;
/** Re-exported so session/card code can talk about roster rows without a second import site. */
export type { WorkBuddyModelInfo };
/** The chat base URL a credential's region resolves to, for diagnostics. */
export { workbuddyChatBase };
//# sourceMappingURL=workbuddy-provider.d.ts.map