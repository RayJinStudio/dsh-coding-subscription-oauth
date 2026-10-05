/**
 * Read and change which DSH web search provider is pinned, through DSH's own
 * `configEditor` service.
 *
 * The web seam selects a provider from its `searchProvider` config field; a
 * shipped base profile pins `deepseek-official`, so a plugin-registered provider
 * is present but never chosen while that pin stands. This module exposes the
 * registered candidates, the effective value, and one guarded write.
 *
 * Persistence goes through `configEditor.edit()`, which owns the profile patch
 * file lock, atomic write, schema validation, rollback, and HMR serialization.
 * This module never writes `cordis.patch.yml` itself.
 *
 * @module dsh-coding-subscription-oauth/search-provider-settings
 */

/** Auto-select: leave `searchProvider` unset so the seam picks the only usable provider. */
export const SEARCH_PROVIDER_AUTO = "" as const;

/** Structural `ctx.configEditor` surface; the real service satisfies it. */
export interface SearchProviderConfigEditor {
	entries(): readonly SearchProviderConfigEntry[];
	configuration(): readonly {
		readonly entry: SearchProviderConfigEntry;
		readonly inherited: Record<string, unknown>;
		readonly override: Record<string, unknown>;
	}[];
	edit(
		entry: SearchProviderConfigEntry,
		change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void>;
}

export interface SearchProviderConfigEntry {
	readonly options: { readonly id: string; readonly name?: string; readonly config?: unknown };
}

/** Structural `ctx.web` surface used to enumerate candidates. */
export interface SearchProviderRegistry {
	readonly searchProviders?: ReadonlyMap<string, { id: string; available(): boolean }> | undefined;
}

export interface SearchProviderOption {
	/** Provider id written into `web.searchProvider`, or "" for auto. */
	readonly id: string;
	/** Whether this provider is built into DSH rather than registered by a plugin. */
	readonly builtIn: boolean;
	/** Cheap local usability check; a provider that is not usable cannot serve search. */
	readonly available: boolean;
}

/** The DSH web row id whose `config.searchProvider` this surface edits. */
export const WEB_ENTRY_ID = "web";

/** Shipped-first ordering so the built-in default stays visually anchored. */
const BUILT_IN_FIRST = ["deepseek-official", "http"];

/** Providers this profile knows about even when the web runtime is not injected yet. */
const FALLBACK_PROVIDERS = ["deepseek-official"] as const;

export interface SearchProviderSettingsOptions {
	/**
	 * Live reader for the config editor. Read per call, not captured, because
	 * Cordis activates on service availability rather than row order: the editor
	 * can become active after this plugin does.
	 */
	readonly configEditor: () => SearchProviderConfigEditor | undefined;
	readonly web: () => SearchProviderRegistry | undefined;
}

export interface SearchProviderSnapshot {
	/** Writable only when both the config editor and the web row are present. */
	readonly writable: boolean;
	/** Effective value; "" means the seam auto-selects. */
	readonly current: string;
	readonly candidates: readonly SearchProviderOption[];
	/** Set when the profile's `web` row could not be addressed. */
	readonly unavailableReason?: string;
}

/**
 * Whether a provider id is one DSH ships rather than one a plugin registered.
 * @param id - candidate provider id.
 * @returns true for the shipped DeepSeek and anonymous-fetch-carrying ids.
 */
export function isBuiltInSearchProvider(id: string): boolean {
	return BUILT_IN_FIRST.includes(id) || FALLBACK_PROVIDERS.includes(id as (typeof FALLBACK_PROVIDERS)[number]);
}

/**
 * Sorted candidate list: shipped built-ins first, then plugin providers by id.
 * @param providers - every registered search provider, by id.
 * @returns options with the auto-select entry excluded (the caller adds it).
 */
export function orderSearchProviders(
	providers:
		| ReadonlyMap<string, { id: string; available(): boolean }>
		| readonly {
				id: string;
				available(): boolean;
		  }[],
): SearchProviderOption[] {
	const availability = new Map<string, boolean>();
	const ids: string[] = [];
	const add = (id: string, available: boolean): void => {
		if (id.length === 0) return;
		if (!availability.has(id)) ids.push(id);
		availability.set(id, (availability.get(id) ?? false) || available);
	};
	const incoming = providers instanceof Map ? [...providers.values()] : providers;
	for (const provider of incoming) add(provider.id, safeAvailable(provider));
	const builtIn = ids.filter(isBuiltInSearchProvider).sort((left, right) => {
		const leftIndex = BUILT_IN_FIRST.indexOf(left);
		const rightIndex = BUILT_IN_FIRST.indexOf(right);
		if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
		if (leftIndex >= 0) return -1;
		if (rightIndex >= 0) return 1;
		return left.localeCompare(right);
	});
	const rest = ids.filter((id) => !isBuiltInSearchProvider(id)).sort((left, right) => left.localeCompare(right));
	return [...builtIn, ...rest].map((id) =>
		Object.freeze({ id, builtIn: isBuiltInSearchProvider(id), available: availability.get(id) === true }),
	);
}

/** `available()` is a cheap local check, but a throwing provider must not blank the list. */
function safeAvailable(provider: { available(): boolean }): boolean {
	try {
		return provider.available() === true;
	} catch {
		return false;
	}
}

/**
 * Read the profile's `web` row.
 * @param editor - the config editor, when the profile provides one.
 * @returns the row plus its inherited and override config layers.
 */
export function readWebEntry(editor: SearchProviderConfigEditor):
	| {
			entry: SearchProviderConfigEntry;
			inherited: Record<string, unknown>;
			override: Record<string, unknown>;
	  }
	| undefined {
	try {
		return editor.configuration().find((row) => row.entry.options.id === WEB_ENTRY_ID);
	} catch {
		return undefined;
	}
}

/**
 * Read the effective provider id. The override layer wins, then the inherited
 * base layer, then a non-empty string already parsed into the live row.
 * @param row - a {@link readWebEntry} result.
 * @returns the configured id, or "" when the seam auto-selects.
 */
export function effectiveSearchProvider(row: {
	readonly inherited: Record<string, unknown>;
	readonly override: Record<string, unknown>;
	readonly entry: SearchProviderConfigEntry;
}): string {
	const fromOverride = row.override["searchProvider"];
	if (typeof fromOverride === "string") return fromOverride;
	const fromInherited = row.inherited["searchProvider"];
	if (typeof fromInherited === "string") return fromInherited;
	const raw = row.entry.options.config;
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		const value = (raw as Record<string, unknown>)["searchProvider"];
		if (typeof value === "string") return value;
	}
	return SEARCH_PROVIDER_AUTO;
}

/** Normalize one requested id; rejects ids this runtime does not know. */
export function assertSearchProviderId(value: unknown, known: readonly string[]): string {
	if (typeof value !== "string") throw new TypeError("searchProvider must be a string");
	const id = value.trim();
	if (id === SEARCH_PROVIDER_AUTO) return id;
	if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || !known.includes(id)) {
		throw new TypeError(`unknown search provider ${id}`);
	}
	return id;
}

/**
 * Secret-free projections over the profile's web search configuration.
 * @param options - the config editor and a live web-registry reader.
 * @returns a reader plus a single guarded writer.
 */
export function createSearchProviderSettings(options: SearchProviderSettingsOptions) {
	const knownIds = (): string[] => {
		const live = [...(options.web()?.searchProviders?.values() ?? [])].map((provider) => provider.id);
		return live.length > 0 ? live : [...FALLBACK_PROVIDERS];
	};

	const candidates = (): SearchProviderOption[] => {
		const registry = options.web()?.searchProviders;
		// With nothing registered yet, still offer the shipped provider so the
		// control is usable before the web runtime finishes registering.
		if (registry === undefined || registry.size === 0) {
			return orderSearchProviders([...FALLBACK_PROVIDERS].map((id) => ({ id, available: () => true })));
		}
		return orderSearchProviders(registry);
	};

	const snapshot = (): SearchProviderSnapshot => {
		const editor = options.configEditor();
		const options_ = candidates();
		if (editor === undefined) {
			return {
				writable: false,
				current: SEARCH_PROVIDER_AUTO,
				candidates: options_,
				unavailableReason: "This profile does not expose its plugin configuration for editing.",
			};
		}
		const row = readWebEntry(editor);
		if (row === undefined) {
			return {
				writable: false,
				current: SEARCH_PROVIDER_AUTO,
				candidates: options_,
				unavailableReason: 'The profile has no "web" configuration row to edit.',
			};
		}
		return { writable: true, current: effectiveSearchProvider(row), candidates: options_ };
	};

	return Object.freeze({
		snapshot,

		/**
		 * Pin (or unpin) the web search provider.
		 * @param value - a candidate id, or "" to return to auto-selection.
		 * @returns the snapshot after the write reconciled through the Loader.
		 */
		async select(value: unknown): Promise<SearchProviderSnapshot> {
			const editor = options.configEditor();
			if (editor === undefined) throw new Error("Plugin configuration editing is unavailable in this profile");
			const row = readWebEntry(editor);
			if (row === undefined) throw new Error('The profile has no "web" configuration row to edit');
			const next = assertSearchProviderId(value, knownIds());
			await editor.edit(row.entry, (current) => {
				const merged = { ...current };
				if (next === SEARCH_PROVIDER_AUTO) delete merged["searchProvider"];
				else merged["searchProvider"] = next;
				return merged;
			});
			return snapshot();
		},
	});
}

export type SearchProviderSettings = ReturnType<typeof createSearchProviderSettings>;
