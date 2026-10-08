/**
 * The Zen route's two structural guarantees, which are the reason it is built
 * in code rather than declared in `llm-pi-ai` settings:
 *
 * 1. One route serves SEVERAL protocols at once, dispatching per model.
 * 2. The free-tier gate shaping is applied to free models and left off paid
 *    ones, instead of being applied blanket.
 *
 * Both are asserted against the real installed pi-ai catalogue, so an upgrade
 * that changes the catalogue's protocol spread fails here rather than in a
 * user's conversation.
 */

import { describe, expect, it } from "vitest";
import { zenToolNames } from "../src/opencode-zen-gate.ts";
import { OPENCODE_ZEN_PROVIDER_ID } from "../src/opencode-zen-ids.ts";
import { shapeZenPayload, zenModelRequiresGate, zenModels } from "../src/opencode-zen-provider.ts";

describe("zenModels", () => {
	it("stamps the plugin's own route id onto every model", () => {
		const models = zenModels();
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) expect(model.provider).toBe(OPENCODE_ZEN_PROVIDER_ID);
	});

	it("carries more than one protocol on a single route", () => {
		// This is the load-bearing fact: a settings-declared route could not do
		// this, because PiAiProviderProfile.api is one protocol for the whole route.
		const protocols = new Set(zenModels().map((model) => model.api));
		expect(protocols.size).toBeGreaterThan(1);
		expect(protocols.has("openai-completions")).toBe(true);
		expect(protocols.has("openai-responses")).toBe(true);
		expect(protocols.has("anthropic-messages")).toBe(true);
	});

	it("narrows to the enabled ids when given a filter", () => {
		const all = zenModels();
		const first = all[0]!;
		const filtered = zenModels((id) => id === first.id);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]!.id).toBe(first.id);
	});

	it("keeps each model's own baseUrl so one route reaches every protocol path", () => {
		const withBase = zenModels().filter((model) => model.baseUrl !== undefined);
		expect(withBase.length).toBe(zenModels().length);
	});
});

describe("zenModelRequiresGate", () => {
	it("gates free-suffixed models only", () => {
		expect(zenModelRequiresGate("mimo-v2.6-flash-free")).toBe(true);
		expect(zenModelRequiresGate("exo-free")).toBe(true);
		expect(zenModelRequiresGate("muse-spark-1.3-contributor-free")).toBe(true);
		// Paid models answer a plain request, so they must NOT be given the gate's
		// synthetic tools — those include a shell the harness cannot execute.
		expect(zenModelRequiresGate("deepseek-v4-pro")).toBe(false);
		expect(zenModelRequiresGate("claude-opus-5-5")).toBe(false);
	});
});

describe("shapeZenPayload", () => {
	it("shapes a free model's body", () => {
		const shaped = shapeZenPayload(
			{ model: "mimo-v2.6-flash-free", stream: false, messages: [] },
			"mimo-v2.6-flash-free",
		) as Record<string, unknown>;
		expect(shaped["stream"]).toBe(true);
		expect(zenToolNames(shaped)).toContain("bash");
	});

	it("leaves a paid model's body untouched, including its own tools", () => {
		const body = {
			model: "deepseek-v4-pro",
			stream: true,
			messages: [],
			tools: [{ type: "function", function: { name: "pwsh" } }],
		};
		const shaped = shapeZenPayload(body, "deepseek-v4-pro") as Record<string, unknown>;
		expect(shaped).toBe(body);
		expect(zenToolNames(shaped)).toEqual(["pwsh"]);
	});

	it("passes non-object payloads through", () => {
		expect(shapeZenPayload(undefined, "mimo-v2.6-flash-free")).toBeUndefined();
		expect(shapeZenPayload("raw", "mimo-v2.6-flash-free")).toBe("raw");
	});
});

describe("installed catalogue still contains the documented free models", () => {
	it("includes the free models this route was built against", () => {
		const ids = new Set(zenModels().map((model) => model.id));
		// If pi-ai drops one of these the gate tests still pass, but the route
		// silently stops offering a model it was verified against.
		for (const id of [
			"mimo-v2.6-flash-free",
			"muse-spark-1.3-contributor-free",
			"muse-spark-1.2-contributor-free",
			"nemotron-3-ultra-free",
		]) {
			expect(ids.has(id), id).toBe(true);
		}
	});
});
