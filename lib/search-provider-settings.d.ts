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
export declare const SEARCH_PROVIDER_AUTO: "";
/** Structural `ctx.configEditor` surface; the real service satisfies it. */
export interface SearchProviderConfigEditor {
    entries(): readonly SearchProviderConfigEntry[];
    configuration(): readonly {
        readonly entry: SearchProviderConfigEntry;
        readonly inherited: Record<string, unknown>;
        readonly override: Record<string, unknown>;
    }[];
    edit(entry: SearchProviderConfigEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
}
export interface SearchProviderConfigEntry {
    readonly options: {
        readonly id: string;
        readonly name?: string;
        readonly config?: unknown;
    };
}
/** Structural `ctx.web` surface used to enumerate candidates. */
export interface SearchProviderRegistry {
    readonly searchProviders?: ReadonlyMap<string, {
        id: string;
        available(): boolean;
    }> | undefined;
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
export declare const WEB_ENTRY_ID = "web";
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
export declare function isBuiltInSearchProvider(id: string): boolean;
/**
 * Sorted candidate list: shipped built-ins first, then plugin providers by id.
 * @param providers - every registered search provider, by id.
 * @returns options with the auto-select entry excluded (the caller adds it).
 */
export declare function orderSearchProviders(providers: ReadonlyMap<string, {
    id: string;
    available(): boolean;
}> | readonly {
    id: string;
    available(): boolean;
}[]): SearchProviderOption[];
/**
 * Read the profile's `web` row.
 * @param editor - the config editor, when the profile provides one.
 * @returns the row plus its inherited and override config layers.
 */
export declare function readWebEntry(editor: SearchProviderConfigEditor): {
    entry: SearchProviderConfigEntry;
    inherited: Record<string, unknown>;
    override: Record<string, unknown>;
} | undefined;
/**
 * Read the effective provider id. The override layer wins, then the inherited
 * base layer, then a non-empty string already parsed into the live row.
 * @param row - a {@link readWebEntry} result.
 * @returns the configured id, or "" when the seam auto-selects.
 */
export declare function effectiveSearchProvider(row: {
    readonly inherited: Record<string, unknown>;
    readonly override: Record<string, unknown>;
    readonly entry: SearchProviderConfigEntry;
}): string;
/** Normalize one requested id; rejects ids this runtime does not know. */
export declare function assertSearchProviderId(value: unknown, known: readonly string[]): string;
/**
 * Secret-free projections over the profile's web search configuration.
 * @param options - the config editor and a live web-registry reader.
 * @returns a reader plus a single guarded writer.
 */
export declare function createSearchProviderSettings(options: SearchProviderSettingsOptions): Readonly<{
    snapshot: () => SearchProviderSnapshot;
    /**
     * Pin (or unpin) the web search provider.
     * @param value - a candidate id, or "" to return to auto-selection.
     * @returns the snapshot after the write reconciled through the Loader.
     */
    select(value: unknown): Promise<SearchProviderSnapshot>;
}>;
export type SearchProviderSettings = ReturnType<typeof createSearchProviderSettings>;
//# sourceMappingURL=search-provider-settings.d.ts.map