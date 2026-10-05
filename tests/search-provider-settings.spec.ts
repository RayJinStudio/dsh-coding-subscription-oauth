/**
 * Search-provider settings: candidate ordering, effective-value resolution, and
 * the guarded write that goes through DSH's configuration editor.
 */
import { describe, expect, it, vi } from "vitest";
import {
	assertSearchProviderId,
	createSearchProviderSettings,
	effectiveSearchProvider,
	isBuiltInSearchProvider,
	orderSearchProviders,
	readWebEntry,
	SEARCH_PROVIDER_AUTO,
	type SearchProviderConfigEditor,
	type SearchProviderConfigEntry,
} from "../src/search-provider-settings.ts";

function entry(config: unknown = {}): SearchProviderConfigEntry {
	return { options: { id: "web", name: "@deepseek-ai/dsh-web", config } };
}

function editor(
	options: {
		row?: { entry: SearchProviderConfigEntry; inherited: Record<string, unknown>; override: Record<string, unknown> };
		onEdit?: (
			change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
		) => void;
	} = {},
): SearchProviderConfigEditor {
	const row = options.row ?? {
		entry: entry({ searchProvider: "deepseek-official" }),
		inherited: { searchProvider: "deepseek-official", fetchProvider: "http" },
		override: {},
	};
	return {
		entries: () => [row.entry],
		configuration: () => [row],
		edit: async (target, change) => {
			options.onEdit?.(change);
			const next = change((target.options.config ?? {}) as Record<string, unknown>, row.inherited);
			// Mirror the loader: the committed row's config becomes the new value.
			(target as { options: { config: unknown } }).options.config = next;
			row.override = next;
		},
	};
}

function registry(ids: readonly string[], unavailable: readonly string[] = []) {
	return {
		searchProviders: new Map(ids.map((id) => [id, { id, available: () => !unavailable.includes(id) }] as const)),
	};
}

describe("search provider classification", () => {
	it("recognizes DSH-shipped providers", () => {
		expect(isBuiltInSearchProvider("deepseek-official")).toBe(true);
		expect(isBuiltInSearchProvider("http")).toBe(true);
		expect(isBuiltInSearchProvider("codex-oauth-search")).toBe(false);
		expect(isBuiltInSearchProvider("kimi-oauth-search")).toBe(false);
	});

	it("orders shipped providers first, then plugin providers by id", () => {
		expect(
			orderSearchProviders(registry(["kimi-oauth-search", "deepseek-official", "codex-oauth-search"]).searchProviders),
		).toEqual([
			{ id: "deepseek-official", builtIn: true, available: true },
			{ id: "codex-oauth-search", builtIn: false, available: true },
			{ id: "kimi-oauth-search", builtIn: false, available: true },
		]);
	});

	it("keeps the shipped DeepSeek provider before an unresolvable built-in id", () => {
		expect(orderSearchProviders(registry(["http", "deepseek-official"]).searchProviders).map((o) => o.id)).toEqual([
			"deepseek-official",
			"http",
		]);
	});

	it("reports usability and survives a throwing availability probe", () => {
		const providers = new Map([
			["kimi-oauth-search", { id: "kimi-oauth-search", available: () => false }],
			[
				"codex-oauth-search",
				{
					id: "codex-oauth-search",
					available: () => {
						throw new Error("probe failed");
					},
				},
			],
		]);
		expect(orderSearchProviders(providers)).toEqual([
			{ id: "codex-oauth-search", builtIn: false, available: false },
			{ id: "kimi-oauth-search", builtIn: false, available: false },
		]);
	});
});

describe("effective search provider", () => {
	it("prefers the override layer over the inherited base", () => {
		expect(
			effectiveSearchProvider({
				entry: entry({ searchProvider: "ignored" }),
				inherited: { searchProvider: "deepseek-official" },
				override: { searchProvider: "kimi-oauth-search" },
			}),
		).toBe("kimi-oauth-search");
	});

	it("falls back to the inherited base, then the live row, then auto", () => {
		expect(
			effectiveSearchProvider({ entry: entry(), inherited: { searchProvider: "deepseek-official" }, override: {} }),
		).toBe("deepseek-official");
		expect(
			effectiveSearchProvider({
				entry: entry({ searchProvider: "codex-oauth-search" }),
				inherited: {},
				override: {},
			}),
		).toBe("codex-oauth-search");
		expect(effectiveSearchProvider({ entry: entry(), inherited: {}, override: {} })).toBe(SEARCH_PROVIDER_AUTO);
	});
});

describe("assertSearchProviderId", () => {
	it("accepts a known id and the empty auto value", () => {
		expect(assertSearchProviderId("kimi-oauth-search", ["kimi-oauth-search"])).toBe("kimi-oauth-search");
		expect(assertSearchProviderId("", ["kimi-oauth-search"])).toBe(SEARCH_PROVIDER_AUTO);
		expect(assertSearchProviderId("  ", ["kimi-oauth-search"])).toBe(SEARCH_PROVIDER_AUTO);
	});

	it("rejects an unknown id, a non-string, and a path-shaped id", () => {
		expect(() => assertSearchProviderId("nope", ["kimi-oauth-search"])).toThrow(/unknown search provider/u);
		expect(() => assertSearchProviderId(1, ["kimi-oauth-search"])).toThrow(/must be a string/u);
		expect(() => assertSearchProviderId("../evil", ["../evil"])).toThrow(/unknown search provider/u);
	});
});

describe("createSearchProviderSettings", () => {
	it("reads the effective value and lists candidates", () => {
		const settings = createSearchProviderSettings({
			configEditor: () => editor(),
			web: () => registry(["deepseek-official", "kimi-oauth-search"]),
		});
		expect(settings.snapshot()).toEqual({
			writable: true,
			current: "deepseek-official",
			candidates: [
				{ id: "deepseek-official", builtIn: true, available: true },
				{ id: "kimi-oauth-search", builtIn: false, available: true },
			],
		});
	});

	it("is read-only without a configuration editor", async () => {
		const settings = createSearchProviderSettings({
			configEditor: () => undefined,
			web: () => registry(["deepseek-official"]),
		});
		const snapshot = settings.snapshot();
		expect(snapshot.writable).toBe(false);
		expect(snapshot.unavailableReason).toMatch(/does not expose/u);
		await expect(settings.select("deepseek-official")).rejects.toThrow(/unavailable/u);
	});

	it("is read-only when the profile has no web row", () => {
		const empty = editor();
		empty.configuration = () => [];
		const settings = createSearchProviderSettings({
			configEditor: () => empty,
			web: () => registry(["deepseek-official"]),
		});
		expect(settings.snapshot().writable).toBe(false);
		expect(settings.snapshot().unavailableReason).toMatch(/no "web" configuration row/u);
	});

	it("writes the selected id and preserves sibling config keys", async () => {
		const seen: Record<string, unknown>[] = [];
		const instance = editor({
			onEdit: (change) =>
				void seen.push(
					change({ searchProvider: "deepseek-official", fetchProvider: "http" }, { fetchProvider: "http" }),
				),
		});
		const settings = createSearchProviderSettings({
			configEditor: () => instance,
			web: () => registry(["deepseek-official", "kimi-oauth-search"]),
		});
		const next = await settings.select("kimi-oauth-search");
		expect(next.current).toBe("kimi-oauth-search");
		// fetchProvider must survive the pin, since a patch replaces the whole config.
		expect(seen[0]).toEqual({ searchProvider: "kimi-oauth-search", fetchProvider: "http" });
	});

	it("clears the pin for the auto selection", async () => {
		let captured: Record<string, unknown> | undefined;
		const instance = editor({
			row: {
				entry: entry({ searchProvider: "kimi-oauth-search" }),
				inherited: {},
				override: { searchProvider: "kimi-oauth-search" },
			},
			onEdit: (change) => {
				captured = change({ searchProvider: "kimi-oauth-search", fetchProvider: "http" }, {});
			},
		});
		const settings = createSearchProviderSettings({
			configEditor: () => instance,
			web: () => registry(["deepseek-official", "kimi-oauth-search"]),
		});
		await settings.select("");
		expect(captured).toEqual({ fetchProvider: "http" });
	});

	it("refuses an id this runtime does not know", async () => {
		const settings = createSearchProviderSettings({
			configEditor: () => editor(),
			web: () => registry(["deepseek-official"]),
		});
		await expect(settings.select("ghost-search")).rejects.toThrow(/unknown search provider/u);
	});

	it("falls back to the shipped provider when nothing is registered yet", () => {
		const settings = createSearchProviderSettings({ configEditor: () => editor(), web: () => undefined });
		expect(settings.snapshot().candidates.map((candidate) => candidate.id)).toEqual(["deepseek-official"]);
	});

	it("becomes writable when the config editor activates after construction", async () => {
		// Cordis activates on service availability, so the editor can arrive late.
		let live: SearchProviderConfigEditor | undefined;
		const settings = createSearchProviderSettings({
			configEditor: () => live,
			web: () => registry(["deepseek-official", "kimi-oauth-search"]),
		});
		expect(settings.snapshot().writable).toBe(false);

		live = editor();
		expect(settings.snapshot().writable).toBe(true);
		await expect(settings.select("kimi-oauth-search")).resolves.toMatchObject({ current: "kimi-oauth-search" });
	});

	it("readWebEntry tolerates a throwing editor", () => {
		const broken: SearchProviderConfigEditor = {
			entries: () => [],
			configuration: () => {
				throw new Error("editor unavailable");
			},
			edit: vi.fn(),
		};
		expect(readWebEntry(broken)).toBeUndefined();
	});
});
