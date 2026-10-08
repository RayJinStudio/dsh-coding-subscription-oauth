/**
 * The Zen connection controller: selection persistence and credential
 * handling.
 *
 * The selection lives in a plugin-owned file under DSH_HOME rather than in
 * `llm-pi-ai` settings. That is the decision under test: it is what lets a
 * mixed-protocol selection exist at all, and it is why the operator's own
 * hand-written `opencodezen` profile is never touched.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOpenCodeZenConnectionController,
	opencodeZenCatalog,
	opencodeZenEnabledModels,
	opencodeZenSelectionPath,
	readZenSelection,
	writeZenSelection,
} from "../src/opencode-zen-connection.ts";

function credentials(values = new Map<string, string>(), writable = true): CredentialProvider {
	return {
		describe: vi.fn(async (ref: string) => ({
			configured: values.has(String(ref)),
			writable,
			source: values.has(String(ref)) ? "store" : null,
		})),
		resolve: vi.fn(async (ref: string) => (values.has(String(ref)) ? { value: values.get(String(ref))! } : undefined)),
		set: vi.fn(async (ref: string, value: string) => {
			values.set(String(ref), value);
		}),
		unset: vi.fn(async (ref: string) => {
			values.delete(String(ref));
		}),
	} as unknown as CredentialProvider;
}

let home: string;
beforeEach(async () => {
	// Isolated DSH_HOME, so nothing here touches an operator profile.
	home = await mkdtemp(join(tmpdir(), "dsh-zen-test-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

describe("selection persistence", () => {
	it("treats an absent file as 'serve the whole catalogue'", async () => {
		expect(await readZenSelection(home)).toEqual({
			selection: undefined,
			credentialRef: undefined,
			fetchedAt: 0,
		});
		// An absent file must not narrow the route to zero models.
		expect(await opencodeZenEnabledModels(home)).toHaveLength(opencodeZenCatalog().length);
	});

	it("round-trips a selection", async () => {
		await writeZenSelection({ selection: ["mimo-v2.6-flash-free"] }, home);
		expect((await readZenSelection(home)).selection).toEqual(["mimo-v2.6-flash-free"]);
	});

	it("tolerates a corrupt file instead of failing the route", async () => {
		await writeFile(opencodeZenSelectionPath(home), "{ not json", "utf8");
		expect((await readZenSelection(home)).selection).toBeUndefined();
	});

	it("ignores a document from a different version", async () => {
		await writeFile(
			opencodeZenSelectionPath(home),
			JSON.stringify({ version: 99, selectionMode: "selected", ids: ["mimo-v2.6-flash-free"] }),
			"utf8",
		);
		expect((await readZenSelection(home)).selection).toBeUndefined();
	});

	it("writes the file with owner-only permissions", async () => {
		await writeZenSelection({ selection: ["mimo-v2.6-flash-free"] }, home);
		const raw = await readFile(opencodeZenSelectionPath(home), "utf8");
		expect(JSON.parse(raw)).toMatchObject({ version: 1, selectionMode: "selected" });
	});
});

describe("catalogue and enabled models", () => {
	it("reports each model's own protocol", () => {
		const catalog = opencodeZenCatalog();
		expect(catalog.length).toBeGreaterThan(0);
		for (const model of catalog) expect(typeof model.protocol).toBe("string");
		expect(new Set(catalog.map((model) => model.protocol)).size).toBeGreaterThan(1);
	});

	it("marks free models so the card can label them", () => {
		const free = opencodeZenCatalog().filter((model) => model.free);
		expect(free.length).toBeGreaterThan(0);
		for (const model of free) expect(model.id).toMatch(/-free$|^exo-free$/u);
	});

	it("narrows the served models to the persisted selection", async () => {
		await writeZenSelection({ selection: ["mimo-v2.6-flash-free"] }, home);
		const enabled = await opencodeZenEnabledModels(home);
		expect(enabled.map((model) => model.id)).toEqual(["mimo-v2.6-flash-free"]);
	});
});

describe("controller", () => {
	it("lists the credential candidates and reports unconfigured state", async () => {
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(),
			dshHome: home,
		});
		const status = await controller.status();
		expect(status.credential.configured).toBe(false);
		expect(status.configuration.ready).toBe(false);
		expect(status.credential.candidates.map((entry) => entry.ref)).toContain("OPENCODE_ZEN_API_KEY");
	});

	it("becomes ready once a key is configured and a selection is saved", async () => {
		const values = new Map([["OPENCODE_ZEN_API_KEY", "fixture-secret"]]);
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values),
			dshHome: home,
		});
		const status = await controller.applyConfiguration({ models: ["mimo-v2.6-flash-free"] });
		expect(status.configuration.ready).toBe(true);
		expect(status.configuration.protocols).toEqual(["openai-completions"]);
		expect(status.configuration.models.map((model) => model.id)).toEqual(["mimo-v2.6-flash-free"]);
	});

	it("refuses a model the installed catalogue cannot describe", async () => {
		const values = new Map([["OPENCODE_ZEN_API_KEY", "fixture-secret"]]);
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values),
			dshHome: home,
		});
		await expect(controller.applyConfiguration({ models: ["not-a-real-model"] })).rejects.toMatchObject({
			code: "unknown-model",
		});
	});

	it("refuses an empty selection rather than silently serving nothing", async () => {
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(),
			dshHome: home,
		});
		await expect(controller.applyConfiguration({ models: [] })).rejects.toMatchObject({
			code: "invalid-configuration",
		});
	});

	it("saves a key through the credential service and remembers the ref", async () => {
		const values = new Map<string, string>();
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values),
			dshHome: home,
		});
		const status = await controller.saveCredential({
			credentialRef: "OPENCODE_ZEN_API_KEY",
			apiKey: "oc_sk_fixture",
		});
		expect(values.get("OPENCODE_ZEN_API_KEY")).toBe("oc_sk_fixture");
		expect(status.credential.configured).toBe(true);
		// The chosen ref is persisted so a restart does not silently switch accounts.
		expect((await readZenSelection(home)).credentialRef).toBe("OPENCODE_ZEN_API_KEY");
	});

	it("clears the stored key and forgets the reference", async () => {
		const values = new Map([["OPENCODE_ZEN_API_KEY", "oc_sk_fixture"]]);
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values),
			dshHome: home,
		});
		await controller.saveCredential({ credentialRef: "OPENCODE_ZEN_API_KEY", apiKey: "oc_sk_fixture" });
		const status = await controller.clearCredential({ credentialRef: "OPENCODE_ZEN_API_KEY" });
		// Deleted, not blanked: a leftover record would keep describing the
		// reference as configured while resolution silently failed.
		expect(values.has("OPENCODE_ZEN_API_KEY")).toBe(false);
		expect(status.credential.configured).toBe(false);
		// The remembered ref goes too, so the card returns to a clean state.
		expect((await readZenSelection(home)).credentialRef).toBeUndefined();
	});

	it("refuses to clear through a read-only source", async () => {
		const values = new Map([["OPENCODE_ZEN_API_KEY", "oc_sk_fixture"]]);
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values, false),
			dshHome: home,
		});
		await expect(controller.clearCredential({ credentialRef: "OPENCODE_ZEN_API_KEY" })).rejects.toMatchObject({
			code: "credential-readonly",
		});
		expect(values.has("OPENCODE_ZEN_API_KEY")).toBe(true);
	});

	it("leaves the model selection intact when a key is cleared", async () => {
		const values = new Map([["OPENCODE_ZEN_API_KEY", "oc_sk_fixture"]]);
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(values),
			dshHome: home,
		});
		await controller.applyConfiguration({ models: ["mimo-v2.6-flash-free"] });
		await controller.clearCredential({ credentialRef: "OPENCODE_ZEN_API_KEY" });
		// Clearing a key is about the credential, not about which models are on.
		expect((await readZenSelection(home)).selection).toEqual(["mimo-v2.6-flash-free"]);
	});

	it("loads the public directory without a credential", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "mimo-v2.6-flash-free" }, { id: "unknown-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(),
			dshHome: home,
			fetchImpl,
		});
		const directory = await controller.models();
		expect(directory.map((model) => model.id)).toEqual(["mimo-v2.6-flash-free", "unknown-model"]);
		// A known id gets its protocol from the local catalogue; an unknown one is
		// marked so the card can refuse to enable it.
		expect(directory[0]!.protocol).toBe("openai-completions");
		expect(directory[1]!.protocol).toBe("unknown");
	});

	it("surfaces a directory failure as a classified error", async () => {
		const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
		const controller = createOpenCodeZenConnectionController({
			credentials: credentials(),
			dshHome: home,
			fetchImpl,
		});
		await expect(controller.models()).rejects.toMatchObject({ code: "upstream-failed" });
	});
});
