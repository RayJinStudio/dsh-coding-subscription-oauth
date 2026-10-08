/**
 * Pins the OpenCode Zen free-tier gate shaping.
 *
 * Every rule asserted here was established against the live endpoint, and each
 * one is a real 403 trigger: this suite exists so a future edit cannot quietly
 * drop a requirement and turn "free model works" back into "free model is
 * refused". The rules are cheap to state and expensive to rediscover.
 */

import { describe, expect, it } from "vitest";
import {
	applyZenGateShape,
	classifyZenUpstreamError,
	isZenGateToolName,
	isZenSessionIdShape,
	OPENCODE_ZEN_GATE_MIN_TOOLS,
	satisfiesZenGate,
	zenBodyProtocol,
	zenGateHeaders,
	zenIdentityId,
	zenSessionId,
	zenToolNames,
} from "../src/opencode-zen-gate.ts";

describe("zenIdentityId", () => {
	it("builds the ses_ shape the gate accepts", () => {
		const id = zenSessionId();
		expect(isZenSessionIdShape(id)).toBe(true);
		expect(id).toHaveLength(30);
		// 12 lowercase hex after the prefix, then 14 base62.
		expect(id.slice(4, 16)).toMatch(/^[0-9a-f]{12}$/u);
		expect(id.slice(16)).toMatch(/^[0-9a-zA-Z]{14}$/u);
	});

	it("bit-inverts the timestamp prefix for sessions, not for requests", () => {
		const now = 1_800_000_000_000;
		expect(zenIdentityId("ses", now)).not.toBe(zenIdentityId("msg", now));
	});

	it("is stable for a fixed timestamp apart from the random suffix", () => {
		const now = 1_800_000_000_000;
		expect(zenIdentityId("ses", now).slice(0, 16)).toBe(zenIdentityId("ses", now).slice(0, 16));
	});

	it.each([
		["uniform random base62, no hex prefix", `ses_${"Z".repeat(12)}${"a".repeat(14)}`],
		["uppercase hex prefix", `ses_${"A".repeat(12)}${"a".repeat(14)}`],
		["missing ses_ prefix", `${"a".repeat(12)}${"b".repeat(14)}`],
		["too short", "ses_abc"],
		["too long", `ses_${"a".repeat(12)}${"b".repeat(15)}`],
	])("rejects %s", (_label, value) => {
		// The gate refuses each of these with 403 FreeTierError.
		expect(isZenSessionIdShape(value)).toBe(false);
	});
});

describe("gate tool roster", () => {
	it("accepts only the observed shell and read names", () => {
		expect(isZenGateToolName("bash")).toBe(true);
		expect(isZenGateToolName("shell")).toBe(true);
		expect(isZenGateToolName("read")).toBe(true);
		// Case-sensitive, and every one of these was refused live.
		for (const name of [
			"Bash",
			"BASH",
			"Read",
			"sh",
			"pwsh",
			"powershell",
			"cmd",
			"terminal",
			"exec",
			"run",
			"cat",
			"view",
			"write",
			"edit",
			"glob",
			"grep",
		]) {
			expect(isZenGateToolName(name), name).toBe(false);
		}
	});

	it("reads both the nested and flat tool shapes", () => {
		expect(
			zenToolNames({
				tools: [
					{ type: "function", function: { name: "bash" } },
					{ type: "function", name: "read" },
					{ name: "shell" },
					{ type: "function", function: { name: "" } },
					"nonsense",
				],
			}),
		).toEqual(["bash", "read", "shell"]);
	});

	it("echoes the harness roster unchanged when it already looks official", () => {
		const body = {
			stream: true,
			tools: [
				{ type: "function", function: { name: "bash" } },
				{ type: "function", function: { name: "read" } },
			],
		};
		expect(satisfiesZenGate(body)).toBe(true);
		expect(applyZenGateShape(body).tools).toHaveLength(2);
	});
});

describe("zenBodyProtocol", () => {
	it("infers each protocol from distinctive body fields", () => {
		expect(zenBodyProtocol({ input: [], stream: true })).toBe("responses");
		expect(zenBodyProtocol({ system: "s", max_tokens: 8, messages: [] })).toBe("messages");
		expect(zenBodyProtocol({ messages: [], stream: true })).toBe("completions");
	});
});

/**
 * Regression: appending a chat-shaped tool to a Responses body makes the
 * upstream reject the whole request with
 * `400 Missing required parameter: tools[N].name`, because Responses tools are
 * flat and its SDK never reads a nested `function`. The shaper must therefore
 * splice the roster in the BODY'S OWN protocol shape.
 */
describe("applyZenGateShape respects the body's protocol tool shape", () => {
	it("appends flat tools to a Responses body", () => {
		const shaped = applyZenGateShape({ input: [], stream: true, tools: [] });
		const added = (shaped.tools as Array<Record<string, unknown>>).at(-2)!;
		expect(added["name"]).toBe("bash");
		expect(added["input_schema"]).toBeUndefined();
		expect(added["function"]).toBeUndefined();
		expect(added["parameters"]).toBeDefined();
	});

	it("appends nested tools to a chat-completions body", () => {
		const shaped = applyZenGateShape({ messages: [], stream: true, tools: [] });
		const added = (shaped.tools as Array<Record<string, unknown>>).at(-2)!;
		expect(added["function"]).toEqual(expect.objectContaining({ name: "bash" }));
		expect(added["name"]).toBeUndefined();
	});

	it("appends input_schema tools to an Anthropic messages body", () => {
		const shaped = applyZenGateShape({ system: "s", max_tokens: 8, messages: [], tools: [] });
		const added = (shaped.tools as Array<Record<string, unknown>>).at(-2)!;
		expect(added["name"]).toBe("bash");
		expect(added["input_schema"]).toBeDefined();
		expect(added["function"]).toBeUndefined();
	});

	it("keeps every caller tool intact while appending", () => {
		// The reported failure had 32 existing flat tools; all 32 must survive.
		const existing = Array.from({ length: 32 }, (_, index) => ({
			type: "function",
			name: `tool${index}`,
			parameters: { type: "object", properties: {}, required: [] },
		}));
		const shaped = applyZenGateShape({ input: [], stream: true, tools: existing });
		const tools = shaped.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(34);
		for (let index = 0; index < 32; index += 1) expect(tools[index]!["name"]).toBe(`tool${index}`);
		expect(tools.every((tool) => typeof tool["name"] === "string" && tool["name"] !== "")).toBe(true);
	});
});

describe("applyZenGateShape", () => {
	it("forces streaming and supplies the required roster", () => {
		const original = { model: "mimo-v2.6-flash-free", stream: false, messages: [] };
		const shaped = applyZenGateShape(original);
		expect(shaped.stream).toBe(true);
		const names = zenToolNames(shaped);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names.length).toBeGreaterThanOrEqual(OPENCODE_ZEN_GATE_MIN_TOOLS);
		expect(satisfiesZenGate(shaped)).toBe(true);
	});

	it("does not mutate the caller's body", () => {
		const original: Record<string, unknown> = { model: "m", stream: false, messages: [] };
		applyZenGateShape(original);
		expect(original.stream).toBe(false);
		expect(original["tools"]).toBeUndefined();
	});

	it("keeps the harness's own tools so real tool calling still works", () => {
		// Windows ships pwsh, which the gate does not accept — the shaper must ADD
		// to this roster, not replace it.
		const shaped = applyZenGateShape({
			stream: true,
			tools: [
				{ type: "function", function: { name: "pwsh" } },
				{ type: "function", function: { name: "read" } },
			],
		});
		const names = zenToolNames(shaped);
		expect(names).toContain("pwsh");
		expect(names).toContain("read");
		expect(names).toContain("bash");
	});

	it("adds only what is missing when the roster is half-right", () => {
		const shaped = applyZenGateShape({
			stream: true,
			tools: [{ type: "function", function: { name: "bash" } }],
		});
		const names = zenToolNames(shaped);
		expect(names.filter((name) => name === "read")).toHaveLength(1);
		expect(names.filter((name) => name === "bash")).toHaveLength(1);
	});
});

describe("zenGateHeaders", () => {
	it("carries a gate-passing session and an opencode User-Agent", () => {
		const headers = zenGateHeaders();
		expect(isZenSessionIdShape(headers["x-opencode-session"])).toBe(true);
		expect(headers["User-Agent"]).toMatch(/^opencode\//u);
		expect(headers["x-opencode-client"]).toBe("cli");
	});

	it("honours an explicit session so a caller can pin one", () => {
		const pinned = "ses_08262184fffe9714Is8tKklgPJ";
		expect(zenGateHeaders({ session: pinned })["x-opencode-session"]).toBe(pinned);
	});
});

describe("classifyZenUpstreamError", () => {
	it("names the free-tier gate as its own failure, not a bad key", () => {
		const failure = classifyZenUpstreamError(
			403,
			JSON.stringify({
				type: "error",
				error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode" },
			}),
		);
		expect(failure.code).toBe("zen-free-tier-rejected");
	});

	it("distinguishes an invalid key from the gate", () => {
		expect(classifyZenUpstreamError(401, '{"error":{"type":"AuthError","message":"Invalid API key."}}').code).toBe(
			"credential-rejected",
		);
	});

	it("falls back to a generic code for other failures", () => {
		expect(classifyZenUpstreamError(500, "boom").code).toBe("upstream-failed");
		expect(classifyZenUpstreamError(200, "{}").code).toBe("upstream-failed");
	});
});
