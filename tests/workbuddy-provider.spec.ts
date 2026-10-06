/**
 * WorkBuddy provider and session: the fixed image-modality policy, context
 * budgets, model derivation, catalog source tracking, and the in-process
 * wire-quirk wrapper that replaces the reference implementation's loopback shim.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from "../src/workbuddy-auth.ts";
import {
	FALLBACK_WORKBUDDY_MODELS,
	WORKBUDDY_NATIVE_MODALITY,
	WORKBUDDY_PI_PROVIDER,
	withWorkBuddyWire,
	workbuddyDisplayName,
	workbuddyModelTakesImages,
	workbuddyPiModel,
	workbuddyProvider,
	workbuddyThinkingLevelMap,
} from "../src/workbuddy-provider.ts";
import { applyWorkBuddyContextBudgets, deriveWorkBuddyCatalog, WorkBuddySession } from "../src/workbuddy-session.ts";
import type { WorkBuddyModelInfo } from "../src/workbuddy-upstream.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workbuddy-session-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function info(overrides: Partial<WorkBuddyModelInfo> = {}): WorkBuddyModelInfo {
	return { id: "m", name: "M", contextWindow: 200_000, maxTokens: 8_000, ...overrides };
}

/**
 * A store double exposing only what the session and provider read.
 *
 * The desktop path is held in a mutable local so the session's persistence path
 * (`setAuthFile` -> `writeCache`) can be exercised: a stateless double would let
 * the pin round-trip "successfully" while storing nothing.
 */
function fakeStore(credential: WorkBuddyCredential | undefined): WorkBuddyCredentialStore {
	let desktopPath: string | undefined;
	return {
		peek: () => credential,
		resolve: async () => {
			if (credential === undefined) throw new Error("not signed in");
			return credential;
		},
		status: async () => (credential === undefined ? { state: "signed-out" } : { state: "signed-in" }),
		setDesktopPath: (path: string | undefined) => {
			desktopPath = path;
		},
		desktopPathOverride: () => desktopPath,
	} as unknown as WorkBuddyCredentialStore;
}

const CREDENTIAL: WorkBuddyCredential = {
	accessToken: "token-a",
	refreshToken: "refresh-a",
	expiresAtMs: Date.now() + 3_600_000,
	domain: "www.workbuddy.cn",
	uid: "uid-1",
	source: "desktop",
	filePath: "/tmp/a.info",
};

describe("fixed image-modality policy", () => {
	it("trusts the reviewed table over the platform flag", () => {
		// The platform flag is true for text-only models on live CN data, so using
		// it directly would advertise image input for models that cannot read images.
		expect(workbuddyModelTakesImages({ id: "glm-5.3", supportsImages: true })).toBe(false);
		expect(workbuddyModelTakesImages({ id: "glm-5.1", supportsImages: true })).toBe(false);
	});

	it("lets a platform 'no' veto a documented multimodal model", () => {
		expect(workbuddyModelTakesImages({ id: "kimi-k3-1", supportsImages: true })).toBe(true);
		expect(workbuddyModelTakesImages({ id: "kimi-k3-1", supportsImages: false })).toBe(false);
	});

	it("leaves an unclassified model text-only rather than inheriting a neighbour's answer", () => {
		expect(workbuddyModelTakesImages({ id: "brand-new-model", supportsImages: true })).toBe(false);
		expect(workbuddyModelTakesImages({ id: "glm-5.3-turbo", supportsImages: true })).toBe(false);
	});

	it("classifies every table entry as exactly one of the two documented states", () => {
		for (const [id, modality] of Object.entries(WORKBUDDY_NATIVE_MODALITY)) {
			expect(["text", "multimodal"]).toContain(modality);
			expect(id).not.toBe("");
		}
		// The table is the fixed policy, so it must not be empty.
		expect(Object.keys(WORKBUDDY_NATIVE_MODALITY).length).toBeGreaterThan(10);
	});
});

describe("workbuddyThinkingLevelMap", () => {
	it("maps declared levels to themselves and pins undeclared ones to null", () => {
		// pi-ai treats an ABSENT key as supported, so an undeclared level must be
		// stated explicitly rather than omitted.
		const map = workbuddyThinkingLevelMap(info({ reasoning: { supportedEfforts: ["low", "high"] } }));
		expect(map).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
	});

	it("returns undefined when the model declares no reasoning at all", () => {
		expect(workbuddyThinkingLevelMap(info())).toBeUndefined();
		expect(workbuddyThinkingLevelMap(info({ reasoning: { supportedEfforts: [] } }))).toBeUndefined();
	});

	it("honours a lone default effort when no ladder was declared", () => {
		expect(workbuddyThinkingLevelMap(info({ reasoning: { defaultEffort: "high" } }))).toMatchObject({ high: "high" });
	});
});

describe("workbuddyDisplayName", () => {
	it("appends the credit rate, and spells a zero rate as free", () => {
		expect(workbuddyDisplayName(info({ name: "GLM-5.3", creditMultiplier: 0.79 }))).toBe("GLM-5.3 · x0.79");
		expect(workbuddyDisplayName(info({ name: "Hy4 preview", creditMultiplier: 0 }))).toBe("Hy4 preview · free");
		expect(workbuddyDisplayName(info({ name: "Auto" }))).toBe("Auto");
	});
});

describe("workbuddyPiModel", () => {
	it("pins the compat flags the gateway requires", () => {
		const model = workbuddyPiModel(info(), "https://copilot.tencent.com/v2") as unknown as {
			compat: Record<string, unknown>;
			provider: string;
			api: string;
		};
		// `developer` must be off: the gateway rejects it with business code 11128,
		// and pi-ai's own detector would otherwise turn it on for this base URL.
		expect(model.compat.supportsDeveloperRole).toBe(false);
		expect(model.compat.supportsStore).toBe(false);
		expect(model.provider).toBe(WORKBUDDY_PI_PROVIDER);
		expect(model.api).toBe("openai-completions");
	});

	it("advertises image input only under the fixed policy", () => {
		const withImages = workbuddyPiModel(info({ id: "kimi-k3-1", supportsImages: true }), "http://x/v2") as unknown as {
			input: string[];
		};
		const textOnly = workbuddyPiModel(info({ id: "glm-5.3", supportsImages: true }), "http://x/v2") as unknown as {
			input: string[];
		};
		expect(withImages.input).toEqual(["text", "image"]);
		expect(textOnly.input).toEqual(["text"]);
	});

	it("carries credential-dependent headers when given them", () => {
		const model = workbuddyPiModel(info(), "http://x/v2", { "X-User-Id": "uid-1" }) as unknown as {
			headers?: Record<string, string>;
		};
		expect(model.headers).toEqual({ "X-User-Id": "uid-1" });
	});
});

describe("withWorkBuddyWire", () => {
	/** A provider double that records the options its stream received. */
	function recordingProvider(): {
		provider: { id: string; stream: unknown; streamSimple: unknown };
		seen: Array<Record<string, unknown>>;
	} {
		const seen: Array<Record<string, unknown>> = [];
		const capture = () => (_model: never, _context: never, options?: Record<string, unknown>) => {
			seen.push(options ?? {});
			return "streamed";
		};
		return { provider: { id: "p", stream: capture(), streamSimple: capture() }, seen };
	}

	it("injects an onPayload that normalizes the body for the gateway", async () => {
		const { provider, seen } = recordingProvider();
		const wrapped = withWorkBuddyWire(provider as never);
		(wrapped.streamSimple as unknown as (a: never, b: never, c: never) => unknown)(
			{} as never,
			{} as never,
			{} as never,
		);
		const hook = seen[0]?.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
		expect(typeof hook).toBe("function");
		// This is the whole reason the route needs no loopback shim: the hook is
		// injected here because `dsh-llm-pi-ai` does not forward one.
		const normalized = (await hook({ messages: [{ role: "user", content: "hi" }] }, {})) as {
			stream: boolean;
			messages: Array<{ role: string }>;
		};
		expect(normalized.stream).toBe(true);
		expect(normalized.messages[0]?.role).toBe("system");
	});

	it("runs a caller-supplied onPayload AFTER normalization, so the caller still wins", async () => {
		const { provider, seen } = recordingProvider();
		const wrapped = withWorkBuddyWire(provider as never);
		let sawNormalized = false;
		(wrapped.streamSimple as unknown as (a: never, b: never, c: never) => unknown)(
			{} as never,
			{} as never,
			{
				onPayload: (payload: unknown) => {
					sawNormalized = (payload as { stream?: boolean }).stream === true;
					return { ...(payload as object), model: "overridden" };
				},
			} as never,
		);
		const hook = seen[0]?.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
		const result = (await hook({ messages: [] }, {})) as { model: string };
		expect(sawNormalized).toBe(true);
		expect(result.model).toBe("overridden");
	});

	it("passes a null payload through rather than crashing on it", async () => {
		const { provider, seen } = recordingProvider();
		const wrapped = withWorkBuddyWire(provider as never);
		(wrapped.stream as unknown as (a: never, b: never, c: never) => unknown)({} as never, {} as never, {} as never);
		const hook = seen[0]?.onPayload as (payload: unknown, model: unknown) => Promise<unknown>;
		expect(await hook(undefined, {})).toBeUndefined();
	});

	it("leaves unrelated provider fields intact", () => {
		const { provider } = recordingProvider();
		const wrapped = withWorkBuddyWire(provider as never);
		expect((wrapped as { id: string }).id).toBe("p");
	});
});

describe("workbuddyProvider", () => {
	it("reads the model list LIVE on every call", () => {
		let roster = [info({ id: "a" })];
		const provider = workbuddyProvider({ models: () => roster.map((model) => workbuddyPiModel(model, "http://x/v2")) });
		expect(provider.getModels().map((model) => model.id)).toEqual(["a"]);
		// A context-budget change or a catalog refresh must reach the next read
		// without rebuilding the provider.
		roster = [info({ id: "a" }), info({ id: "b" })];
		expect(provider.getModels().map((model) => model.id)).toEqual(["a", "b"]);
	});
});

describe("applyWorkBuddyContextBudgets", () => {
	it("only ever lowers a window, so a budget above it is a no-op", () => {
		const catalog = [info({ id: "big", contextWindow: 1_000_000 }), info({ id: "small", contextWindow: 192_000 })];
		const applied = applyWorkBuddyContextBudgets(catalog, { big: 200_000, small: 500_000 });
		expect(applied[0]?.contextWindow).toBe(200_000);
		expect(applied[1]?.contextWindow).toBe(192_000);
	});

	it("keeps the native window when no budget is stored", () => {
		expect(applyWorkBuddyContextBudgets([info({ contextWindow: 256_000 })], {})[0]?.contextWindow).toBe(256_000);
	});

	it("ignores a non-positive or non-finite budget instead of zeroing the window", () => {
		for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(applyWorkBuddyContextBudgets([info({ contextWindow: 1000 })], { m: budget })[0]?.contextWindow).toBe(1000);
		}
	});

	it("does not mutate the input rows", () => {
		const catalog = [info({ contextWindow: 1_000_000 })];
		applyWorkBuddyContextBudgets(catalog, { m: 200_000 });
		expect(catalog[0]?.contextWindow).toBe(1_000_000);
	});
});

describe("deriveWorkBuddyCatalog", () => {
	const catalog = [info({ id: "a" }), info({ id: "b" }), info({ id: "c" })];

	it("serves EVERY model when the selection is empty", () => {
		// A plugin that has never been configured must still serve models rather
		// than presenting an empty picker.
		expect(deriveWorkBuddyCatalog(catalog, new Set()).map((model) => model.id)).toEqual(["a", "b", "c"]);
	});

	it("keeps only the selected models", () => {
		expect(deriveWorkBuddyCatalog(catalog, new Set(["b"])).map((model) => model.id)).toEqual(["b"]);
	});

	it("applies budgets to the derived set", () => {
		const derived = deriveWorkBuddyCatalog([info({ id: "a", contextWindow: 1_000_000 })], new Set(), { a: 500_000 });
		expect(derived[0]?.contextWindow).toBe(500_000);
	});
});

describe("WorkBuddySession", () => {
	it("serves the static baseline before the first fetch lands", () => {
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(tmpdir(), "unused.json"));
		expect(session.catalogSource).toBe("fallback");
		expect(session.availableModels().length).toBe(FALLBACK_WORKBUDDY_MODELS.length);
	});

	it("keeps the static baseline when the catalog fetch fails", async () => {
		const dir = await tempDir();
		vi.stubGlobal("fetch", async () => {
			throw new Error("network down");
		});
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		await session.refreshCatalog();
		expect(session.catalogSource).toBe("fallback");
		expect(session.catalogError).toBeDefined();
		expect(session.availableModels().length).toBeGreaterThan(0);
	});

	it("adopts the live roster on success and persists the selection and budgets", async () => {
		const dir = await tempDir();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						code: 0,
						msg: "OK",
						data: { models: [{ id: "live-a", maxInputTokens: 100_000, maxOutputTokens: 1000 }] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		const cacheFile = join(dir, "models.json");
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, cacheFile);
		await session.refreshCatalog();
		expect(session.catalogSource).toBe("live");
		expect(session.availableModels().map((model) => model.id)).toEqual(["live-a"]);

		await session.setSelectedModels(["live-a"]);
		await session.setContextBudget("live-a", 50_000);
		expect(session.selectedModelIds()).toEqual(["live-a"]);
		expect(session.contextBudgets()).toEqual({ "live-a": 50_000 });
		expect(session.visibleModels()[0]?.contextWindow).toBe(50_000);

		// The state is reloadable, which is what makes a restart keep the choice.
		const revived = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, cacheFile);
		await revived.loadCachedState();
		expect(revived.selectedModelIds()).toEqual(["live-a"]);
		expect(revived.contextBudgets()).toEqual({ "live-a": 50_000 });
	});

	it("treats an absent selection as 'all models' for the checkbox view", async () => {
		const dir = await tempDir();
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		// Before any explicit selection, every baseline model reads as enabled.
		expect(session.selectedModelIds()).toBeUndefined();
		expect(session.enabledModelIds()).toEqual(FALLBACK_WORKBUDDY_MODELS.map((model) => model.id));
	});

	it("supports an explicit empty selection, which is 'serve nothing'", async () => {
		const dir = await tempDir();
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		await session.setSelectedModels([]);
		expect(session.selectedModelIds()).toEqual([]);
		expect(session.visibleModels()).toEqual([]);
		expect(session.enabledModelIds()).toEqual([]);
	});

	it("clears the budget when set to undefined", async () => {
		const dir = await tempDir();
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		await session.setContextBudget("m", 500_000);
		expect(session.contextBudgets()).toEqual({ m: 500_000 });
		await session.setContextBudget("m", undefined);
		expect(session.contextBudgets()).toEqual({});
	});

	it("builds pi-ai models on the route with the credential's headers", async () => {
		const dir = await tempDir();
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		const models = session.piModels("https://copilot.tencent.com/v2", { "X-User-Id": "uid-1" });
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.provider === WORKBUDDY_PI_PROVIDER)).toBe(true);
		expect((models[0] as unknown as { baseUrl: string }).baseUrl).toBe("https://copilot.tencent.com/v2");
	});

	it("reset drops the persisted selection", async () => {
		const dir = await tempDir();
		const session = new WorkBuddySession(fakeStore(CREDENTIAL), undefined, join(dir, "models.json"));
		await session.setSelectedModels(["x"]);
		await session.reset();
		expect(session.selectedModelIds()).toBeUndefined();
		expect(session.contextBudgets()).toEqual({});
	});
});
