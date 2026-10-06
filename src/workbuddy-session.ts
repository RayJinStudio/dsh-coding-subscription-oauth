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

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelCacheQueue, writeModelCache } from "./model-cache.ts";
import { safeMessage } from "./redact.ts";
import type { WorkBuddyCredential, WorkBuddyCredentialStore } from "./workbuddy-auth.ts";
import { FALLBACK_WORKBUDDY_MODELS, type WorkBuddyModelInfo, workbuddyPiModel } from "./workbuddy-provider.ts";
import { fetchWorkBuddyCatalog } from "./workbuddy-upstream.ts";

/** Cache document version; readers reject anything else. */
const CACHE_VERSION = 1;

/** Filename of the plugin-owned catalog/selection cache. */
export const WORKBUDDY_MODELS_CACHE_FILENAME = ".workbuddy-models.json";

/** Where the catalog came from on the last read. */
export type WorkBuddyCatalogSource = "live" | "cache" | "fallback";

interface CacheDocument {
	version: typeof CACHE_VERSION;
	selectionMode: "default" | "selected";
	/** Enabled model ids; meaningful only when `selectionMode` is `selected`. */
	selected: string[];
	budgets: Record<string, number>;
	/**
	 * The pinned auth file, or absent for the platform defaults.
	 *
	 * Persisted here because the choice is otherwise process-local: the store
	 * holds the override in memory only, so without this a restart silently
	 * reverts discovery to the platform path — the user's selection would appear
	 * to have been ignored, and their account would change under them.
	 */
	desktopPath?: string;
	fetchedAt: number;
}

/** Parsed cache state. */
interface ParsedCache {
	/** Undefined means "serve every model". */
	selection?: string[];
	budgets: Record<string, number>;
	/** Undefined means "use the platform defaults". */
	desktopPath?: string;
}

/** A per-model context budget, in tokens. */
export type WorkBuddyContextBudget = number;

/**
 * Apply the saved local budgets to a catalog.
 *
 * `Math.min` is the whole semantics: a budget can only lower a window, so a
 * value above the native one changes nothing instead of misreporting the model
 * as capable of more than it is.
 */
export function applyWorkBuddyContextBudgets(
	catalog: readonly WorkBuddyModelInfo[],
	budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
	return catalog.map((model) => {
		const budget = budgets[model.id];
		if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return { ...model };
		return { ...model, contextWindow: Math.min(model.contextWindow, budget) };
	});
}

/**
 * Derive the runtime roster from the live catalog plus the user's selection.
 *
 * An EMPTY selection means "everything", not "nothing": a plugin that has never
 * been configured must still serve models rather than an empty picker.
 */
export function deriveWorkBuddyCatalog(
	catalog: readonly WorkBuddyModelInfo[],
	enabled: ReadonlySet<string>,
	budgets: Readonly<Record<string, WorkBuddyContextBudget | undefined>> = {},
): WorkBuddyModelInfo[] {
	const selected = enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id));
	return applyWorkBuddyContextBudgets(selected, budgets);
}

function isENOENT(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Resolve the plugin-owned cache path beneath DSH_HOME. */
export function workbuddyModelsCachePath(dshHome?: string): string {
	return resolve(join(resolveDshHome(dshHome), WORKBUDDY_MODELS_CACHE_FILENAME));
}

/** Coerce an untrusted value into a deduped list of non-empty strings. */
function idList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/** Coerce an untrusted value into a budget map of positive finite numbers. */
function budgetMap(value: unknown): Record<string, number> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out: Record<string, number> = {};
	for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
		if (id === "" || typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
		out[id] = Math.floor(raw);
	}
	return out;
}

function parseCache(text: string): ParsedCache | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const document = parsed as Record<string, unknown>;
	if (document["version"] !== CACHE_VERSION) return undefined;
	const selected = idList(document["selected"]);
	const desktopPath = document["desktopPath"];
	return {
		...(document["selectionMode"] === "selected" ? { selection: selected } : {}),
		budgets: budgetMap(document["budgets"]),
		// Only a non-empty string pins a file; anything else means the defaults.
		...(typeof desktopPath === "string" && desktopPath.trim() !== "" ? { desktopPath: desktopPath.trim() } : {}),
	};
}

/** One process-local owner of the WorkBuddy credential, catalog and selection. */
export class WorkBuddySession {
	private liveCatalog: readonly WorkBuddyModelInfo[] | undefined;
	private selection: string[] | undefined;
	private budgets: Record<string, number> = {};
	private source: WorkBuddyCatalogSource = "fallback";
	private listingError: string | undefined;
	private readonly cacheFile: string;
	private readonly cacheQueue = new ModelCacheQueue();
	private readonly onCatalogChange: (() => void) | undefined;

	constructor(
		readonly store: WorkBuddyCredentialStore,
		onCatalogChange?: () => void,
		cacheFile: string = workbuddyModelsCachePath(),
	) {
		this.cacheFile = resolve(cacheFile);
		this.onCatalogChange = onCatalogChange;
	}

	/** Secret-free listing diagnostic from the last refresh. */
	get catalogError(): string | undefined {
		return this.listingError;
	}

	get catalogSource(): WorkBuddyCatalogSource {
		return this.source;
	}

	/** The upstream roster, or the static baseline before the first fetch lands. */
	availableModels(): readonly WorkBuddyModelInfo[] {
		return this.liveCatalog ?? FALLBACK_WORKBUDDY_MODELS;
	}

	/** The user's explicit selection, or undefined when everything is served. */
	selectedModelIds(): string[] | undefined {
		return this.selection === undefined ? undefined : [...this.selection];
	}

	/**
	 * Ids the user has switched on, for the card's checkboxes.
	 *
	 * Derived rather than stored separately: an ABSENT selection means "every
	 * model", so the effective set is the whole roster in that case and the
	 * explicit list otherwise. Keeping one source of truth is what stops the
	 * checkboxes and the served roster from disagreeing.
	 */
	enabledModelIds(): string[] {
		if (this.selection === undefined) return this.availableModels().map((model) => model.id);
		return [...this.selection];
	}

	/** Saved per-model context budgets. */
	contextBudgets(): Readonly<Record<string, number>> {
		return { ...this.budgets };
	}

	/** The roster DSH should expose, after selection and context budgets. */
	visibleModels(): WorkBuddyModelInfo[] {
		const available = this.availableModels();
		const selected =
			this.selection === undefined
				? available
				: this.selection.flatMap((id) => {
						const model = available.find((entry) => entry.id === id);
						return model === undefined ? [] : [model];
					});
		return applyWorkBuddyContextBudgets(selected, this.budgets);
	}

	/** The roster as pi-ai models on the WorkBuddy route. */
	piModels(baseUrl: string, headers: Record<string, string> = {}): Model<Api>[] {
		return this.visibleModels().map((model) => workbuddyPiModel(model, baseUrl, headers));
	}

	/**
	 * Load the persisted selection, budgets and pinned auth file.
	 *
	 * The auth file is restored FIRST, before anything reads the credential: the
	 * whole point of pinning one is that discovery must not consult the platform
	 * default, so restoring it after a catalog read would answer the first
	 * request from the wrong account.
	 */
	async loadCachedState(): Promise<void> {
		try {
			const cache = parseCache(await readFile(this.cacheFile, "utf8"));
			if (cache === undefined) return;
			if (cache.desktopPath !== undefined) this.store.setDesktopPath(cache.desktopPath);
			this.selection = cache.selection;
			this.budgets = cache.budgets;
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}

	/**
	 * Persist which auth file is pinned. `undefined` restores the platform defaults.
	 *
	 * Writes through the same queue as the model selection so a concurrent
	 * catalog refresh cannot clobber it with a document that predates the change.
	 */
	async setAuthFile(path: string | undefined): Promise<void> {
		await this.cacheQueue.run(async () => {
			this.store.setDesktopPath(path);
			await this.writeCache();
		});
	}

	/** The auth file currently pinned, if any. */
	authFile(): string | undefined {
		return this.store.desktopPathOverride();
	}

	/**
	 * Fetch the account's live roster.
	 *
	 * A failure keeps the last good list and reports it, so a transient gateway
	 * error never empties the model picker.
	 */
	async refreshCatalog(signal?: AbortSignal): Promise<void> {
		try {
			const credential = await this.store.resolve();
			const live = await fetchWorkBuddyCatalog(credential, signal, (message) => {
				this.listingError = message;
			});
			await this.cacheQueue.run(async () => {
				this.liveCatalog = live;
				this.source = "live";
				await this.writeCache();
			});
			if (this.listingError?.startsWith("WorkBuddy catalog ")) return;
			this.listingError = undefined;
		} catch (error: unknown) {
			this.listingError = safeMessage(error);
			if (this.liveCatalog === undefined) this.source = "fallback";
		} finally {
			// Sign-in must reveal the roster even when the fetch failed.
			this.onCatalogChange?.();
		}
	}

	/** Persist the model selection. `undefined` restores "serve every model". */
	async setSelectedModels(ids: readonly string[] | undefined): Promise<void> {
		const selected = ids === undefined ? undefined : [...new Set(ids.filter((id) => id.length > 0))];
		await this.cacheQueue.run(async () => {
			this.selection = selected;
			await this.writeCache();
		});
		this.onCatalogChange?.();
	}

	/**
	 * Persist one model's context budget.
	 *
	 * A budget equal to the native window is stored as the native number, which
	 * is how the card's "native" radio is expressed — there is no clear path, so
	 * the value the user sees is always the value on disk.
	 */
	async setContextBudget(modelId: string, budget: number | undefined): Promise<void> {
		await this.cacheQueue.run(async () => {
			if (budget === undefined) delete this.budgets[modelId];
			else this.budgets[modelId] = Math.floor(budget);
			await this.writeCache();
		});
		this.onCatalogChange?.();
	}

	/**
	 * Forget the credential-derived state for a full logout.
	 *
	 * The pinned auth file is released too: a logout means "start over from the
	 * platform default", and keeping the pin would silently re-point discovery at
	 * the very account the user just dropped.
	 */
	async reset(): Promise<void> {
		return this.cacheQueue.run(async () => {
			try {
				this.liveCatalog = undefined;
				this.selection = undefined;
				this.budgets = {};
				this.source = "fallback";
				this.listingError = undefined;
				this.store.setDesktopPath(undefined);
				await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
				await rm(this.cacheFile, { force: true });
			} finally {
				// Cache cleanup may fail after the credential is gone; always refresh
				// discovery so an open picker cannot retain stale models.
				this.onCatalogChange?.();
			}
		});
	}

	private async writeCache(): Promise<void> {
		const desktopPath = this.store.desktopPathOverride();
		const document: CacheDocument = {
			version: CACHE_VERSION,
			selectionMode: this.selection === undefined ? "default" : "selected",
			selected: this.selection === undefined ? [] : [...this.selection],
			budgets: { ...this.budgets },
			...(desktopPath === undefined ? {} : { desktopPath }),
			fetchedAt: Date.now(),
		};
		await writeModelCache(this.cacheFile, document);
	}
}

/** The credential a session sends upstream, for route wiring. */
export type { WorkBuddyCredential };
