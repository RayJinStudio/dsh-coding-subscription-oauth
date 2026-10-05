/**
 * Optional Kimi Code subscription search against the official
 * `POST https://api.kimi.com/coding/v1/search` endpoint. Default-off: parent
 * registers the returned provider only when the user enables it.
 *
 * The endpoint is a standalone search service, not an LLM-mediated one: its
 * request body carries only `text_query`. Verified against Moonshot's own CLI
 * (`MoonshotWebSearchProvider`) and the `dsh-kimi-subscription` plugin, neither
 * of which sends a model. There is therefore no model selector for this
 * provider, unlike the Codex one whose body carries `model`.
 *
 * @module dsh-coding-subscription-oauth/kimi-search
 */

import { LlmError } from "@deepseek-ai/dsh-llm";
import { isRecord } from "./codex-http.ts";
import type { KimiAuthSession } from "./kimi-usage.ts";
import { safeMessage } from "./redact.ts";

/** Stable search-provider id. Parent must not write this into `web.searchProvider` by default. */
export const KIMI_SEARCH_PROVIDER_ID = "kimi-oauth-search";

/** Official Kimi Code search endpoint. */
export const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";

export const DEFAULT_KIMI_SEARCH_TIMEOUT_MS = 15_000;

/** Upper bound on a provider-supplied publication date string. */
const MAX_SOURCE_DATE = 64;

export interface KimiSearchSource {
	readonly url: string;
	readonly title?: string;
	readonly snippet?: string;
	readonly publishedAt?: string;
}

export interface KimiSearchRequest {
	readonly query: string;
	readonly maxResults?: number;
}

export interface KimiSearchResult {
	readonly sources: readonly KimiSearchSource[];
	readonly truncated: boolean;
}

export interface KimiSearchProviderOptions {
	readonly auth: KimiAuthSession;
	readonly fetchImpl?: typeof fetch | undefined;
	readonly url?: string | undefined;
	readonly timeoutMs?: number | undefined;
}

/** Structural `WebSearchProvider` so parent can register without this module importing dsh-web. */
export interface KimiSearchProvider {
	readonly id: typeof KIMI_SEARCH_PROVIDER_ID;
	available(): boolean;
	search(request: KimiSearchRequest, signal?: AbortSignal): Promise<KimiSearchResult>;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayText(value: unknown): string | undefined {
	const text = nonEmpty(value)?.replace(/\s+/gu, " ").trim();
	return text === undefined || text.length === 0 ? undefined : text;
}

function boundedDisplayText(value: unknown, maximum: number): string | undefined {
	const text = displayText(value);
	if (text === undefined || text.length <= maximum) return text;
	return `${text.slice(0, maximum - 1)}…`;
}

/** Accept only citeable http(s) URLs with no embedded credentials. */
function citeableHttpUrl(value: unknown): string | undefined {
	const raw = nonEmpty(value);
	if (raw === undefined) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username !== "" || url.password !== "") return undefined;
		return raw;
	} catch {
		return undefined;
	}
}

function sourceOf(value: unknown): KimiSearchSource | undefined {
	if (!isRecord(value)) return undefined;
	const url = citeableHttpUrl(value["url"]);
	if (url === undefined) return undefined;
	let hostname: string | undefined;
	try {
		hostname = new URL(url).hostname;
	} catch {
		hostname = undefined;
	}
	const title = displayText(value["title"]) ?? displayText(value["site_name"]) ?? hostname;
	const snippet = displayText(value["snippet"]) ?? displayText(value["content"]);
	const publishedAt = boundedDisplayText(value["date"], MAX_SOURCE_DATE);
	return {
		url,
		...(title === undefined ? {} : { title }),
		...(snippet === undefined ? {} : { snippet }),
		...(publishedAt === undefined ? {} : { publishedAt }),
	};
}

/** Reject `<1` / non-finite `maxResults` rather than treating them as unlimited. */
export function assertKimiSearchMaxResults(maxResults: number | undefined): void {
	if (maxResults === undefined) return;
	if (!Number.isFinite(maxResults) || maxResults < 1) {
		throw new LlmError("Kimi search maxResults must be a finite number of at least 1", "INVALID_ARGS");
	}
}

/**
 * Normalize the official `/search` payload into the DSH citation result.
 * Only rows with a citeable http(s) URL are kept; URLs are de-duplicated.
 */
export function mapKimiSearchResponse(value: unknown, maxResults?: number): KimiSearchResult {
	assertKimiSearchMaxResults(maxResults);
	if (!isRecord(value) || !Array.isArray(value["search_results"])) {
		throw new LlmError("Kimi returned a malformed search response", "SERVER");
	}
	const sources: KimiSearchSource[] = [];
	const seen = new Set<string>();
	for (const row of value["search_results"]) {
		const source = sourceOf(row);
		if (source === undefined || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
	}
	const limited = maxResults === undefined ? sources : sources.slice(0, maxResults);
	return { sources: limited, truncated: limited.length < sources.length };
}

/**
 * Factory for an injectable, default-off Kimi Code search provider.
 * The subscription access token stays host-side and is never logged or returned.
 */
export function createKimiSearchProvider(options: KimiSearchProviderOptions): KimiSearchProvider {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const url = options.url ?? KIMI_SEARCH_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_KIMI_SEARCH_TIMEOUT_MS;
	return {
		id: KIMI_SEARCH_PROVIDER_ID,
		available: () => true,
		async search(request, signal) {
			// `throwIfAborted()` would leak a raw DOMException instead of the
			// stable LlmError code the seam routes on.
			if (signal?.aborted === true) {
				throw new LlmError("Kimi search aborted", "TIMEOUT", { cause: signal.reason });
			}
			const query = request.query.trim();
			if (query.length === 0) {
				throw new LlmError("Kimi search requires a non-empty query", "INVALID_ARGS");
			}
			assertKimiSearchMaxResults(request.maxResults);
			const resolution = await options.auth.resolve();
			if (resolution?.accessToken === undefined || resolution.accessToken.length === 0) {
				throw new LlmError("Kimi Code subscription is not connected", "INVALID_ARGS");
			}
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					// Credential-bearing request: never follow a redirect to another origin.
					redirect: "error",
					headers: {
						Authorization: `Bearer ${resolution.accessToken}`,
						Accept: "application/json",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ text_query: query }),
					signal: requestSignal,
				});
			} catch (error: unknown) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
					throw new LlmError("Kimi search aborted", "TIMEOUT", { cause: error });
				}
				throw new LlmError(`Kimi search request failed (${safeMessage(error)})`, "TRANSPORT", { cause: error });
			}
			if (response.status === 401 || response.status === 403) {
				// Expired session: drop the cached token so the next attempt refreshes.
				await options.auth.invalidate();
				throw new LlmError("Kimi Code subscription sign-in needs to be renewed (HTTP 401). Sign in again.", "AUTH");
			}
			if (response.status === 402) {
				throw new LlmError("Kimi Code subscription quota is currently unavailable", "QUOTA");
			}
			if (!response.ok) {
				throw new LlmError(`Kimi search request failed (HTTP ${String(response.status)})`, "SERVER");
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch (error: unknown) {
				throw new LlmError("Kimi returned an unreadable search response", "SERVER", { cause: error });
			}
			return mapKimiSearchResponse(payload, request.maxResults);
		},
	};
}
