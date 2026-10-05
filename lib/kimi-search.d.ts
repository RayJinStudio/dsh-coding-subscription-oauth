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
import type { KimiAuthSession } from "./kimi-usage.js";
/** Stable search-provider id. Parent must not write this into `web.searchProvider` by default. */
export declare const KIMI_SEARCH_PROVIDER_ID = "kimi-oauth-search";
/** Official Kimi Code search endpoint. */
export declare const KIMI_SEARCH_URL = "https://api.kimi.com/coding/v1/search";
export declare const DEFAULT_KIMI_SEARCH_TIMEOUT_MS = 15000;
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
/** Reject `<1` / non-finite `maxResults` rather than treating them as unlimited. */
export declare function assertKimiSearchMaxResults(maxResults: number | undefined): void;
/**
 * Normalize the official `/search` payload into the DSH citation result.
 * Only rows with a citeable http(s) URL are kept; URLs are de-duplicated.
 */
export declare function mapKimiSearchResponse(value: unknown, maxResults?: number): KimiSearchResult;
/**
 * Factory for an injectable, default-off Kimi Code search provider.
 * The subscription access token stays host-side and is never logged or returned.
 */
export declare function createKimiSearchProvider(options: KimiSearchProviderOptions): KimiSearchProvider;
//# sourceMappingURL=kimi-search.d.ts.map