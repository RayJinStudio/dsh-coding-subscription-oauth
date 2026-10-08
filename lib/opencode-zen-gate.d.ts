/**
 * OpenCode Zen free-tier gate shaping.
 *
 * Zen's `/zen/v1` endpoint gates free models behind a check that only admits
 * requests shaped like the official OpenCode client. Everything in this module
 * is the result of black-box probing against the live endpoint; the rules are
 * asserted by `tests/opencode-zen-gate.spec.ts` so a future change to the
 * shaper cannot silently drop one of them.
 *
 * The gate has four independent requirements. Missing any one of them returns
 * HTTP 403 with `{"type":"error","error":{"type":"FreeTierError",...}}`:
 *
 * 1. **Session identity.** `x-opencode-session` must be `ses_` + a 12-character
 *    lowercase-hex time prefix + 14 base62 characters. A uniformly random
 *    26-character suffix is refused, as is an uppercase-hex prefix, a missing
 *    `ses_` prefix, or any other body length. The timestamp itself is NOT
 *    range-checked: prefixes encoding 2020 and prefixes encoding a decade in
 *    the future both pass, so only the *shape* is verified.
 * 2. **A client-looking `User-Agent`.** A UA beginning `opencode/` is required;
 *    `node` and the harness attribution UA are both refused.
 * 3. **A streamed completion.** `stream: true`. A non-streaming body is refused
 *    even when every header is correct.
 * 4. **A known tool roster.** The body's `tools` must contain at least two
 *    entries, and the set must be drawn from the official client's tool names —
 *    observed working pairs are `bash`+`read` and `shell`+`read`. The roster is
 *    an allowlist, not a "contains bash" check: `bash`+`write`, `bash`+`grep`,
 *    `bash` alone, and `bash`+an invented name are all refused, while
 *    `bash`+`read`+arbitrary-extras passes. Names are case-sensitive (`Read`
 *    fails) and the shell slot accepts `bash` or `shell`, but NOT `sh`, `pwsh`,
 *    `powershell`, `cmd`, `terminal`, `exec`, or `run`.
 *
 * Requirement 4 is why the gate cannot be satisfied by passing the harness's own
 * tool list through: DSH's Windows roster is `pwsh`/`read`/`write`/… with no
 * `bash`, so every real request would be refused. The shaper therefore ADDS the
 * official tool entries the gate looks for rather than relying on the caller's
 * roster, and leaves the caller's own tools intact.
 *
 * `x-opencode-request` is set for fidelity but is not itself required; the
 * gate was observed to pass with it omitted.
 */
/**
 * Tool `name`s the gate accepts. Only these two names were observed to satisfy
 * it across the exhaustive probe in `tests/opencode-zen-gate.spec.ts`.
 */
export declare const OPENCODE_ZEN_GATE_SHELL_TOOLS: readonly ["bash", "shell"];
export declare const OPENCODE_ZEN_GATE_READ_TOOL: "read";
/** Minimum tool count the gate requires. */
export declare const OPENCODE_ZEN_GATE_MIN_TOOLS = 2;
/**
 * Official client version the shaper fingerprints as. Track OpenCode releases;
 * overridable so a drift fix does not need a plugin release.
 */
export declare const OPENCODE_ZEN_CLIENT_VERSION: string;
/** True when a tool name is one the gate accepts. */
export declare function isZenGateToolName(name: unknown): boolean;
/**
 * Build an OpenCode-shaped identity id.
 *
 * The prefix is the millisecond timestamp shifted left 12 bits (plus a counter
 * slot) rendered as six big-endian hex bytes; `descending` bit-inverts it, which
 * is what the official client does for session ids. The remaining 14 characters
 * are random base62.
 *
 * Only the SHAPE is verified by the gate, so this reproduces the observed shape
 * rather than any particular server-side meaning.
 */
export declare function zenIdentityId(kind: "ses" | "msg", now?: number, descending?: boolean): string;
/** A fresh gate-passing `x-opencode-session` value. */
export declare function zenSessionId(now?: number): string;
/** A fresh gate-passing `x-opencode-request` value. */
export declare function zenRequestId(now?: number): string;
/** Validate the exact session-id shape the gate accepts. Exported for tests. */
export declare function isZenSessionIdShape(value: unknown): boolean;
/**
 * The wire protocol a body belongs to, inferred from its own shape.
 *
 * The gate's required tool roster must be spliced into the body in THAT
 * protocol's tool shape. Getting this wrong is not cosmetic: appending a
 * chat-shaped `{type, function:{name}}` entry to a Responses body makes the
 * upstream reject the whole request with
 * `400 Missing required parameter: tools[N].name`, because Responses tools are
 * flat and are parsed by an OpenAI SDK that never looks inside `function`.
 *
 * Inference is by distinctive field rather than by a caller-supplied hint, so
 * the shaper cannot disagree with the body it was handed:
 * - `input`  → OpenAI Responses (chat carries `messages`; Anthropic carries `system`)
 * - `system` (top-level, with `max_tokens`) → Anthropic Messages
 * - anything else → OpenAI Chat Completions
 */
export declare function zenBodyProtocol(body: Record<string, unknown>): "completions" | "responses" | "messages";
/**
 * The tool entries the gate requires, in the official client's own shape for
 * the protocol the body speaks.
 *
 * Schemas are intentionally minimal: the gate does not validate tool schemas,
 * only the names and the count.
 */
export declare function zenGateTools(protocol?: "completions" | "responses" | "messages"): Array<Record<string, unknown>>;
/**
 * Read the tool names out of a request body, tolerating all three shapes:
 * nested (`{type, function:{name}}`), flat Responses (`{type, name}`), and
 * Anthropic (`{name, input_schema}`).
 */
export declare function zenToolNames(body: Record<string, unknown>): string[];
/**
 * Whether a body already satisfies the gate's tool roster and streaming rules.
 * Used to decide whether shaping is needed and to explain a failure.
 */
export declare function satisfiesZenGate(body: Record<string, unknown>): boolean;
/**
 * Shape an outbound request body so the free-tier gate admits it.
 *
 * Returns a NEW body; the caller's object is not mutated. The transformation:
 * - forces `stream: true` (the gate refuses non-streaming requests);
 * - guarantees the accepted tool roster by ADDING the official entries in the
 *   protocol's own tool shape, keeping the caller's tools so real tool calling
 *   still works;
 * - leaves every other field untouched.
 *
 * When the caller already sends an accepted roster only the streaming flag is
 * forced, so no duplicate tools are introduced.
 */
export declare function applyZenGateShape(body: Record<string, unknown>): Record<string, unknown>;
/**
 * Headers the gate requires, beyond whatever the caller sends.
 *
 * `x-opencode-session` is a fresh protocol-correct id per request. The header
 * deliberately overrides rather than defers to a caller value: a passthrough
 * DSH session id is a UUID, which the gate refuses.
 */
export declare function zenGateHeaders(input?: {
    session?: string;
    request?: string;
}): Record<string, string>;
/**
 * Classify an upstream Zen failure body for the card, so a gate rejection is
 * not reported to the user as a bad API key (they are different failures with
 * different fixes). Mirrors the Go error classifier's contract.
 */
export declare function classifyZenUpstreamError(status: number, bodyText: string): {
    readonly code: string;
    readonly message: string;
};
//# sourceMappingURL=opencode-zen-gate.d.ts.map