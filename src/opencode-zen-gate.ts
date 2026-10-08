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

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Tool `name`s the gate accepts. Only these two names were observed to satisfy
 * it across the exhaustive probe in `tests/opencode-zen-gate.spec.ts`.
 */
export const OPENCODE_ZEN_GATE_SHELL_TOOLS = ["bash", "shell"] as const;
export const OPENCODE_ZEN_GATE_READ_TOOL = "read" as const;

/** Minimum tool count the gate requires. */
export const OPENCODE_ZEN_GATE_MIN_TOOLS = 2;

/**
 * Official client version the shaper fingerprints as. Track OpenCode releases;
 * overridable so a drift fix does not need a plugin release.
 */
export const OPENCODE_ZEN_CLIENT_VERSION: string =
	process.env["OPENCODE_ZEN_USER_AGENT"] ?? "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";

/** True when a tool name is one the gate accepts. */
export function isZenGateToolName(name: unknown): boolean {
	return (
		typeof name === "string" &&
		((OPENCODE_ZEN_GATE_SHELL_TOOLS as readonly string[]).includes(name) || name === OPENCODE_ZEN_GATE_READ_TOOL)
	);
}

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
export function zenIdentityId(kind: "ses" | "msg", now: number = Date.now(), descending = kind === "ses"): string {
	let value = BigInt(now) * 0x1000n + 1n;
	if (descending) value = ~value;
	let prefix = "";
	for (let index = 0; index < 6; index += 1) {
		prefix += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0");
	}
	const random = new Uint8Array(14);
	globalThis.crypto.getRandomValues(random);
	let suffix = "";
	for (const byte of random) suffix += ID_ALPHABET[byte % 62];
	return `${kind}_${prefix}${suffix}`;
}

/** A fresh gate-passing `x-opencode-session` value. */
export function zenSessionId(now?: number): string {
	return zenIdentityId("ses", now);
}

/** A fresh gate-passing `x-opencode-request` value. */
export function zenRequestId(now?: number): string {
	return zenIdentityId("msg", now);
}

/** Validate the exact session-id shape the gate accepts. Exported for tests. */
export function isZenSessionIdShape(value: unknown): boolean {
	return typeof value === "string" && /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/u.test(value);
}

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
export function zenBodyProtocol(body: Record<string, unknown>): "completions" | "responses" | "messages" {
	if ("input" in body) return "responses";
	if ("system" in body || ("max_tokens" in body && !("messages" in body))) return "messages";
	return "completions";
}

/** One gate tool entry in the exact shape the given protocol expects. */
function zenGateTool(protocol: "completions" | "responses" | "messages", name: string): Record<string, unknown> {
	const description = name === "bash" ? "Run a shell command" : "Read a file";
	const parameters = { type: "object", properties: {}, required: [] };
	if (protocol === "completions") {
		return { type: "function", function: { name, description, parameters } };
	}
	if (protocol === "responses") {
		// Flat, with the JSON Schema inline: the Responses SDK reads `name` here
		// and `parameters` beside it, never a nested `function` object.
		return { type: "function", name, description, parameters, strict: false };
	}
	// Anthropic Messages: `input_schema`, and no `type` discriminator.
	return { name, description, input_schema: parameters };
}

/**
 * The tool entries the gate requires, in the official client's own shape for
 * the protocol the body speaks.
 *
 * Schemas are intentionally minimal: the gate does not validate tool schemas,
 * only the names and the count.
 */
export function zenGateTools(
	protocol: "completions" | "responses" | "messages" = "completions",
): Array<Record<string, unknown>> {
	return [zenGateTool(protocol, "bash"), zenGateTool(protocol, "read")];
}

/**
 * Read the tool names out of a request body, tolerating all three shapes:
 * nested (`{type, function:{name}}`), flat Responses (`{type, name}`), and
 * Anthropic (`{name, input_schema}`).
 */
export function zenToolNames(body: Record<string, unknown>): string[] {
	const tools = body["tools"];
	if (!Array.isArray(tools)) return [];
	const names: string[] = [];
	for (const entry of tools) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const nested = record["function"];
		const name =
			nested !== null && typeof nested === "object"
				? (nested as Record<string, unknown>)["name"]
				: (record["name"] ?? record["tool_name"]);
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return names;
}

/**
 * Whether a body already satisfies the gate's tool roster and streaming rules.
 * Used to decide whether shaping is needed and to explain a failure.
 */
export function satisfiesZenGate(body: Record<string, unknown>): boolean {
	if (body["stream"] !== true) return false;
	const names = zenToolNames(body);
	if (names.length < OPENCODE_ZEN_GATE_MIN_TOOLS) return false;
	return names.some((name) => isZenGateToolName(name)) && names.includes(OPENCODE_ZEN_GATE_READ_TOOL);
}

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
export function applyZenGateShape(body: Record<string, unknown>): Record<string, unknown> {
	const shaped: Record<string, unknown> = { ...body, stream: true };
	const names = zenToolNames(body);
	const hasShell = names.some((name) => (OPENCODE_ZEN_GATE_SHELL_TOOLS as readonly string[]).includes(name));
	const hasRead = names.includes(OPENCODE_ZEN_GATE_READ_TOOL);
	if (hasShell && hasRead) return shaped;
	const protocol = zenBodyProtocol(body);
	const existing = Array.isArray(body["tools"]) ? (body["tools"] as unknown[]) : [];
	const additions = zenGateTools(protocol).filter((entry) => {
		const entryName = protocol === "completions" ? (entry["function"] as { name: string }).name : String(entry["name"]);
		return entryName === "bash" ? !hasShell : !hasRead;
	});
	shaped["tools"] = [...existing, ...additions];
	return shaped;
}

/**
 * Headers the gate requires, beyond whatever the caller sends.
 *
 * `x-opencode-session` is a fresh protocol-correct id per request. The header
 * deliberately overrides rather than defers to a caller value: a passthrough
 * DSH session id is a UUID, which the gate refuses.
 */
export function zenGateHeaders(input?: { session?: string; request?: string }): Record<string, string> {
	return {
		"User-Agent": OPENCODE_ZEN_CLIENT_VERSION,
		"x-opencode-client": "cli",
		"x-opencode-project": "global",
		"x-opencode-session": input?.session ?? zenSessionId(),
		"x-opencode-request": input?.request ?? zenRequestId(),
	};
}

/**
 * Classify an upstream Zen failure body for the card, so a gate rejection is
 * not reported to the user as a bad API key (they are different failures with
 * different fixes). Mirrors the Go error classifier's contract.
 */
export function classifyZenUpstreamError(
	status: number,
	bodyText: string,
): { readonly code: string; readonly message: string } {
	let type = "";
	let message = "";
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			const root = parsed as Record<string, unknown>;
			const error = root["error"];
			if (error !== null && typeof error === "object") {
				const nested = error as Record<string, unknown>;
				if (typeof nested["type"] === "string") type = nested["type"];
				if (typeof nested["message"] === "string") message = nested["message"];
			}
			if (type === "" && typeof root["type"] === "string") type = root["type"];
			if (message === "" && typeof root["message"] === "string") message = root["message"];
		}
	} catch {
		message = bodyText.trim().slice(0, 300);
	}
	if (type === "FreeTierError" || /free tier can only be used/i.test(message)) {
		return {
			code: "zen-free-tier-rejected",
			message:
				message ||
				"OpenCode Zen refused the request as outside its free-tier client gate. Reload this plugin version; the gate shape may have changed.",
		};
	}
	if (status === 401 || /invalid api key/i.test(message)) {
		return { code: "credential-rejected", message: message || `OpenCode Zen returned HTTP ${status}` };
	}
	if (status === 403) {
		return { code: "upstream-forbidden", message: message || "OpenCode Zen returned HTTP 403" };
	}
	return { code: "upstream-failed", message: message || `OpenCode Zen returned HTTP ${status}` };
}
