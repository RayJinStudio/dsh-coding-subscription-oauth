/**
 * WorkBuddy session: one process-local owner of the credential, the live model
 * catalog, the user's model selection and the per-model context budgets.
 *
 * Per-model context budgets are the ONLY context-length control, mirroring the
 * reference implementation: there is no global tier, because a tier applied to
 * every model would name a cap some models cannot reach. A budget is an UPPER
 * LIMIT the user sets, never a default — a model without one keeps its own
 * window, and {@link applyWorkBuddyContextBudgets} can only ever LOWER it, so a
 * value above the native window is a no-op rather than an error.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-session
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from "./workbuddy-auth.js";
import { type WorkBuddyModelInfo } from "./workbuddy-provider.js";
/** Filename of the plugin-owned catalog/selection cache. */
export declare const WORKBUDDY_MODELS_CACHE_FILENAME = ".workbuddy-models.json";
/** Where the catalog came from on the last read. */
export type WorkBuddyCatalogSource = "live" | "cache" | "fallback";
/** A per-model context budget, in tokens. */
export type WorkBuddyContextBudget = number;
/**
 * Apply the saved local budgets to a catalog.
 *
 * `Math.min` is the whole semantics: a budget can only lower a window, so a
 * value above the native one changes nothing instead of misreporting the model
 * as capable of more than it is.
 */
export declare function applyWorkBuddyContextBudgets(catalog: readonly WorkBuddyModelInfo[], budgets?: Readonly<Record<string, WorkBuddyContextBudget | undefined>>): WorkBuddyModelInfo[];
/**
 * Derive the runtime roster from the live catalog plus the user's selection.
 *
 * An EMPTY selection means "everything", not "nothing": a plugin that has never
 * been configured must still serve models rather than an empty picker.
 */
export declare function deriveWorkBuddyCatalog(catalog: readonly WorkBuddyModelInfo[], enabled: ReadonlySet<string>, budgets?: Readonly<Record<string, WorkBuddyContextBudget | undefined>>): WorkBuddyModelInfo[];
/** Resolve the plugin-owned cache path beneath DSH_HOME. */
export declare function workbuddyModelsCachePath(dshHome?: string): string;
/** One process-local owner of the WorkBuddy credential, catalog and selection. */
export declare class WorkBuddySession {
    readonly store: WorkBuddyCredentialStore;
    private liveCatalog;
    private selection;
    private budgets;
    private source;
    private listingError;
    private readonly cacheFile;
    private readonly cacheQueue;
    private readonly onCatalogChange;
    constructor(store: WorkBuddyCredentialStore, onCatalogChange?: () => void, cacheFile?: string);
    /** Secret-free listing diagnostic from the last refresh. */
    get catalogError(): string | undefined;
    get catalogSource(): WorkBuddyCatalogSource;
    /** The upstream roster, or the static baseline before the first fetch lands. */
    availableModels(): readonly WorkBuddyModelInfo[];
    /** The user's explicit selection, or undefined when everything is served. */
    selectedModelIds(): string[] | undefined;
    /**
     * Ids the user has switched on, for the card's checkboxes.
     *
     * Derived rather than stored separately: an ABSENT selection means "every
     * model", so the effective set is the whole roster in that case and the
     * explicit list otherwise. Keeping one source of truth is what stops the
     * checkboxes and the served roster from disagreeing.
     */
    enabledModelIds(): string[];
    /** Saved per-model context budgets. */
    contextBudgets(): Readonly<Record<string, number>>;
    /** The roster DSH should expose, after selection and context budgets. */
    visibleModels(): WorkBuddyModelInfo[];
    /** The roster as pi-ai models on the WorkBuddy route. */
    piModels(baseUrl: string, headers?: Record<string, string>): Model<Api>[];
    /**
     * Load the persisted selection, budgets and pinned auth file.
     *
     * The auth file is restored FIRST, before anything reads the credential: the
     * whole point of pinning one is that discovery must not consult the platform
     * default, so restoring it after a catalog read would answer the first
     * request from the wrong account.
     */
    loadCachedState(): Promise<void>;
    /**
     * Persist which auth file is pinned. `undefined` restores the platform defaults.
     *
     * Writes through the same queue as the model selection so a concurrent
     * catalog refresh cannot clobber it with a document that predates the change.
     */
    setAuthFile(path: string | undefined): Promise<void>;
    /** The auth file currently pinned, if any. */
    authFile(): string | undefined;
    /**
     * Fetch the account's live roster.
     *
     * A failure keeps the last good list and reports it, so a transient gateway
     * error never empties the model picker.
     */
    refreshCatalog(signal?: AbortSignal): Promise<void>;
    /** Persist the model selection. `undefined` restores "serve every model". */
    setSelectedModels(ids: readonly string[] | undefined): Promise<void>;
    /**
     * Persist one model's context budget.
     *
     * A budget equal to the native window is stored as the native number, which
     * is how the card's "native" radio is expressed — there is no clear path, so
     * the value the user sees is always the value on disk.
     */
    setContextBudget(modelId: string, budget: number | undefined): Promise<void>;
    /**
     * Forget the credential-derived state for a full logout.
     *
     * The pinned auth file is released too: a logout means "start over from the
     * platform default", and keeping the pin would silently re-point discovery at
     * the very account the user just dropped.
     */
    reset(): Promise<void>;
    private writeCache;
}
/** The credential a session sends upstream, for route wiring. */
export type { WorkBuddyCredential };
//# sourceMappingURL=workbuddy-session.d.ts.map