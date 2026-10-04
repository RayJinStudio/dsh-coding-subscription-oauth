/**
 * Kimi Code subscription quota reader (`GET https://api.kimi.com/coding/v1/usages`).
 * Normalizes official /usages payload into clean JSON without exposing tokens.
 *
 * Cache semantics:
 * - A successful `read()` stores the result until `ttlMs` elapses.
 * - Concurrent non-force `read()` calls share one in-flight GET.
 * - `read({ force: true })` bypasses cache and initiates a new GET.
 * - `clear()` drops the stored cache.
 * - 401 response invalidates auth and retries once with a fresh token.
 *
 * @module dsh-coding-subscription-oauth/kimi-usage
 */
export declare const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
export declare const DEFAULT_KIMI_USAGE_TTL_MS = 60000;
export declare const DEFAULT_KIMI_USAGE_TIMEOUT_MS = 15000;
export interface KimiUsageWindow {
    readonly duration: number;
    readonly unit: "minute" | "hour" | "day" | "week";
}
export interface KimiUsageRow {
    readonly name?: string | undefined;
    readonly window?: KimiUsageWindow | undefined;
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
    readonly remainingPercent: number;
    readonly resetAt?: string | undefined;
}
export interface KimiBoosterWallet {
    readonly balanceCents: number;
    readonly totalCents: number;
    readonly monthlyChargeLimitEnabled: boolean;
    readonly monthlyChargeLimitCents: number;
    readonly monthlyUsedCents: number;
    readonly currency: string;
}
export interface KimiUsage {
    readonly summary: KimiUsageRow | null;
    readonly limits: readonly KimiUsageRow[];
    readonly extraUsage: KimiBoosterWallet | null;
    readonly fetchedAt: number;
}
export interface KimiAuthSession {
    resolve(): Promise<{
        accessToken: string;
    } | undefined>;
    invalidate(): Promise<void>;
}
export interface KimiUsageReaderOptions {
    readonly auth: KimiAuthSession;
    readonly fetchImpl?: typeof fetch | undefined;
    readonly now?: (() => number) | undefined;
    readonly url?: string | undefined;
    readonly ttlMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
}
export interface KimiUsageReader {
    read(options?: {
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<KimiUsage>;
    clear(): void;
}
/** Normalize official /usages response payload into clean typed structure. */
export declare function parseKimiUsage(payload: unknown, fetchedAt?: number): KimiUsage;
export declare function kimiAuthFromSession(session: {
    resolveAccessToken(): Promise<string | undefined>;
    invalidateAccessToken(): Promise<void>;
}): KimiAuthSession;
/**
 * Creates a cached, concurrency-deduplicated Kimi Code usage reader.
 */
export declare function createKimiUsageReader(options: KimiUsageReaderOptions): KimiUsageReader;
//# sourceMappingURL=kimi-usage.d.ts.map