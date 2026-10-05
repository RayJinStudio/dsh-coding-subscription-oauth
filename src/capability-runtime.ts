/**
 * Side-effect coordination for default-off optional capabilities.
 *
 * This module contains no Cordis service lookup. The parent supplies structural
 * registries, which keeps live flag transitions deterministic and unit-testable.
 * @module dsh-coding-subscription-oauth/capability-runtime
 */

import { LlmError } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
	type CapabilitySettings,
	DEFAULT_CAPABILITY_SETTINGS,
	normalizeCapabilitySettings,
} from "./capability-settings.ts";
import { CODEX_IMAGE_EDIT_TOOL, CODEX_IMAGE_GENERATE_TOOL } from "./capability-tools.ts";
import type { CodexModelCapabilities } from "./codex-model-capabilities.ts";
import type { CodexSearchRequest } from "./codex-search.ts";
import { GROK_IMAGINE_IMAGE_TOOL, GROK_IMAGINE_VIDEO_STATUS_TOOL, GROK_IMAGINE_VIDEO_TOOL } from "./grok-imagine.ts";
import { CODEX_OAUTH_FAST_ROUTE, CODING_OAUTH_ROUTES } from "./ids.ts";
import { KIMI_SEARCH_PROVIDER_ID } from "./kimi-search.ts";

export type CapabilityRuntimeListener = (settings: CapabilitySettings) => void | Promise<void>;

/** Process-local live projection shared by optional service fibers. */
export class CapabilityRuntimeState {
	private value: CapabilitySettings;
	private readonly listeners = new Set<CapabilityRuntimeListener>();
	private readonly onListenerError: (error: unknown) => void;

	constructor(
		initial: CapabilitySettings = DEFAULT_CAPABILITY_SETTINGS,
		onListenerError: (error: unknown) => void = () => undefined,
	) {
		this.value = normalizeCapabilitySettings(initial);
		this.onListenerError = onListenerError;
	}

	current(): CapabilitySettings {
		return this.value;
	}

	set(next: unknown): CapabilitySettings {
		const normalized = normalizeCapabilitySettings(next);
		if (sameSettings(this.value, normalized)) return this.value;
		this.value = normalized;
		this.refresh();
		return this.value;
	}

	/** Re-run live bindings after an external dependency (for example OAuth) changed. */
	refresh(): void {
		for (const listener of [...this.listeners]) {
			try {
				const result = listener(this.value);
				if (result !== undefined) void Promise.resolve(result).catch(this.onListenerError);
			} catch (error: unknown) {
				this.onListenerError(error);
			}
		}
	}

	reset(): CapabilitySettings {
		return this.set(DEFAULT_CAPABILITY_SETTINGS);
	}

	subscribe(listener: CapabilityRuntimeListener, emitCurrent = true): () => void {
		this.listeners.add(listener);
		if (emitCurrent) {
			try {
				const result = listener(this.value);
				if (result !== undefined) {
					void Promise.resolve(result).catch((error: unknown) => {
						this.listeners.delete(listener);
						this.onListenerError(error);
					});
				}
			} catch (error: unknown) {
				this.listeners.delete(listener);
				throw error;
			}
		}
		return () => {
			this.listeners.delete(listener);
		};
	}
}

/**
 * Structural `WebSearchProvider` shared by every subscription search provider,
 * so one binding serves both without this module importing `dsh-web` and
 * without naming either provider's concrete result type.
 */
export interface SubscriptionSearchProvider {
	readonly id: string;
	available(): boolean;
	search(
		request: { readonly query: string; readonly maxResults?: number },
		signal?: AbortSignal,
	): Promise<{ readonly sources: readonly { readonly url: string }[]; readonly truncated: boolean }>;
}

export interface CapabilitySearchRegistry {
	registerSearchProvider(provider: SubscriptionSearchProvider): () => void;
}

/**
 * The capability flag that owns each search provider. Both providers share the
 * registration lifecycle, but each is published only while its own flag is on.
 */
function searchFlagFor(providerId: string): "codexSearch" | "kimiSearch" {
	return providerId === KIMI_SEARCH_PROVIDER_ID ? "kimiSearch" : "codexSearch";
}

/** Owner name used in the disabled-request failure message. */
function searchLabelFor(providerId: string): string {
	return providerId === KIMI_SEARCH_PROVIDER_ID ? "Kimi" : "Codex";
}

/**
 * Dynamically expose one search provider behind its own capability flag,
 * clamping every request to the live result limit.
 */
export function bindCapabilitySearch(
	state: CapabilityRuntimeState,
	registry: CapabilitySearchRegistry,
	provider: SubscriptionSearchProvider,
): () => void {
	const flag = searchFlagFor(provider.id);
	const label = searchLabelFor(provider.id);
	let release: (() => void) | undefined;
	let disposed = false;
	const gated: SubscriptionSearchProvider = {
		id: provider.id,
		available: () => state.current()[flag] && provider.available(),
		async search(request: CodexSearchRequest, signal?: AbortSignal) {
			const settings = state.current();
			if (!settings[flag]) {
				throw new LlmError(`${label} search is disabled`, "INVALID_ARGS");
			}
			const requested = request.maxResults ?? settings.searchResults;
			const maxResults = Math.min(requested, settings.searchResults);
			return provider.search({ ...request, maxResults }, signal);
		},
	};
	const reconcile = (settings: CapabilitySettings): void => {
		if (disposed) return;
		if (settings[flag] && release === undefined) {
			release = registry.registerSearchProvider(gated);
			return;
		}
		if (!settings[flag] && release !== undefined) {
			release();
			release = undefined;
		}
	};
	const unsubscribe = state.subscribe(reconcile);
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		release?.();
		release = undefined;
	};
}

export interface CapabilityToolRegistry {
	register(definition: ToolDefinition): () => void;
}

/** Return whether one optional tool should currently be advertised. */
export function capabilityToolEnabled(name: string, settings: CapabilitySettings): boolean {
	switch (name) {
		case CODEX_IMAGE_GENERATE_TOOL:
			return settings.codexImages;
		case CODEX_IMAGE_EDIT_TOOL:
			return settings.codexImages && settings.codexImageEdits;
		case GROK_IMAGINE_IMAGE_TOOL:
			return settings.grokImagineImage;
		case GROK_IMAGINE_VIDEO_TOOL:
		case GROK_IMAGINE_VIDEO_STATUS_TOOL:
			return settings.grokImagineVideo;
		default:
			return false;
	}
}

/** Dynamically advertise only enabled tools; execute-time guards remain in each definition. */
export function bindCapabilityTools(
	state: CapabilityRuntimeState,
	registry: CapabilityToolRegistry,
	definitions: readonly ToolDefinition[],
): () => void {
	const byName = new Map(definitions.map((definition) => [definition.name, definition]));
	const releases = new Map<string, () => void>();
	let disposed = false;
	const reconcile = (settings: CapabilitySettings): void => {
		if (disposed) return;
		for (const [name, definition] of byName) {
			const enabled = capabilityToolEnabled(name, settings);
			const release = releases.get(name);
			if (enabled && release === undefined) {
				releases.set(name, registry.register(definition));
			} else if (!enabled && release !== undefined) {
				release();
				releases.delete(name);
			}
		}
	};
	const unsubscribe = state.subscribe(reconcile);
	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		for (const release of releases.values()) release();
		releases.clear();
	};
}

export interface ReplaceableAdapterRegistration {
	replace(routes: string[]): void;
}

export interface CapabilityTimer {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface CodexFastBindingOptions {
	readonly refreshIntervalMs?: number;
	readonly timer?: CapabilityTimer;
	readonly onError?: (error: unknown) => void;
}

const DEFAULT_FAST_REFRESH_INTERVAL_MS = 60_000;

/**
 * Publish the Fast route only after a fresh live catalog explicitly lists at
 * least one priority-eligible model. Disabling is synchronous; stale or failed
 * refreshes atomically withdraw the optional route.
 */
export function bindCodexFastRoute(
	state: CapabilityRuntimeState,
	capabilities: CodexModelCapabilities,
	registration: ReplaceableAdapterRegistration,
	options: CodexFastBindingOptions = {},
): () => void {
	const timer: CapabilityTimer = options.timer ?? {
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	};
	const intervalMs = options.refreshIntervalMs ?? DEFAULT_FAST_REFRESH_INTERVAL_MS;
	const reportError = options.onError ?? (() => undefined);
	let interval: unknown;
	let generation = 0;
	let disposed = false;
	let fastPublished = false;

	const replace = (enabled: boolean): void => {
		if (enabled === fastPublished) return;
		registration.replace(enabled ? [...CODING_OAUTH_ROUTES, CODEX_OAUTH_FAST_ROUTE] : [...CODING_OAUTH_ROUTES]);
		fastPublished = enabled;
	};
	const stopTimer = (): void => {
		if (interval === undefined) return;
		timer.clearInterval(interval);
		interval = undefined;
	};
	const ensureTimer = (): void => {
		if (disposed || interval !== undefined || intervalMs <= 0) return;
		interval = timer.setInterval(() => {
			void reconcile().catch(reportError);
		}, intervalMs);
	};
	const withdraw = (): boolean => {
		try {
			replace(false);
			return true;
		} catch (error: unknown) {
			reportError(error);
			return false;
		}
	};
	const reconcile = async (): Promise<void> => {
		const run = ++generation;
		if (disposed || !state.current().codexFast) {
			if (withdraw()) stopTimer();
			else ensureTimer();
			return;
		}
		ensureTimer();
		const cached = capabilities.getCached();
		if (cached === undefined) {
			// Logout, import, and TTL expiry withdraw the route synchronously before
			// a private catalog refresh is allowed to publish it again.
			replace(false);
		} else {
			replace(cached.some((model) => capabilities.isPriorityEligible(model.id)));
		}
		try {
			const models = await capabilities.refresh();
			if (disposed || run !== generation || !state.current().codexFast) return;
			replace(models.some((model) => capabilities.isPriorityEligible(model.id)));
		} catch (error: unknown) {
			if (!disposed && run === generation) withdraw();
			reportError(error);
		}
	};
	const unsubscribe = state.subscribe((settings) => {
		if (!settings.codexFast) {
			generation += 1;
			if (withdraw()) stopTimer();
			else ensureTimer();
			return;
		}
		void reconcile().catch(reportError);
	});

	return () => {
		if (disposed) return;
		disposed = true;
		generation += 1;
		unsubscribe();
		stopTimer();
		try {
			replace(false);
		} catch (error: unknown) {
			reportError(error);
		}
	};
}

function sameSettings(left: CapabilitySettings, right: CapabilitySettings): boolean {
	return (
		left.codexSearch === right.codexSearch &&
		left.kimiSearch === right.kimiSearch &&
		left.codexImages === right.codexImages &&
		left.codexImageEdits === right.codexImageEdits &&
		left.codexImagesAnyModel === right.codexImagesAnyModel &&
		left.codexUsage === right.codexUsage &&
		left.codexFast === right.codexFast &&
		left.grokImagineImage === right.grokImagineImage &&
		left.grokImagineVideo === right.grokImagineVideo &&
		left.searchResults === right.searchResults &&
		left.imageCount === right.imageCount &&
		left.videoArtifactTtlMs === right.videoArtifactTtlMs
	);
}
