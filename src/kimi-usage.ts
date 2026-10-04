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

export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
export const DEFAULT_KIMI_USAGE_TTL_MS = 60_000;
export const DEFAULT_KIMI_USAGE_TIMEOUT_MS = 15_000;

const FIXED_POINT_CENTS = 1_000_000;

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
	resolve(): Promise<{ accessToken: string } | undefined>;
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
	read(options?: { force?: boolean; signal?: AbortSignal }): Promise<KimiUsage>;
	clear(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.trunc(parsed);
	}
	return undefined;
}

function nameFrom(value: unknown): string | undefined {
	return isRecord(value) && typeof value["name"] === "string" && value["name"].length > 0 ? value["name"] : undefined;
}

function resetAtFrom(value: unknown): string | undefined {
	return isRecord(value) && typeof value["resetTime"] === "string" && value["resetTime"].length > 0
		? value["resetTime"]
		: undefined;
}

/** Read the normalized projection's ISO reset stamp (`resetAt`). */
function normalizedResetAt(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeUnit(value: unknown): KimiUsageWindow["unit"] | undefined {
	switch (value) {
		case "TIME_UNIT_MINUTE":
			return "minute";
		case "TIME_UNIT_HOUR":
			return "hour";
		case "TIME_UNIT_DAY":
			return "day";
		case "TIME_UNIT_WEEK":
			return "week";
		default:
			return undefined;
	}
}

function windowFrom(value: unknown): KimiUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const duration = integer(value["duration"]);
	const unit = normalizeUnit(value["timeUnit"]);
	if (duration === undefined || duration <= 0 || unit === undefined) return undefined;
	if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
		return { duration: duration / 60, unit: "hour" };
	}
	return { duration, unit };
}

function usageRow(
	value: unknown,
	extra: { name?: string | undefined; window?: KimiUsageWindow | undefined } = {},
): KimiUsageRow | null {
	if (!isRecord(value)) return null;
	const used = integer(value["used"]);
	const limit = integer(value["limit"]);
	if (used === undefined && limit === undefined) return null;
	const normalizedUsed = Math.max(0, used ?? 0);
	const normalizedLimit = Math.max(0, limit ?? 0);
	const remaining = Math.max(0, normalizedLimit - normalizedUsed);
	const remainingPercent = normalizedLimit > 0 ? Math.max(0, Math.min(100, (remaining / normalizedLimit) * 100)) : 0;
	const name = extra.name ?? nameFrom(value);
	const resetAt = resetAtFrom(value);
	return {
		...(name !== undefined ? { name } : {}),
		...(extra.window !== undefined ? { window: extra.window } : {}),
		used: normalizedUsed,
		limit: normalizedLimit,
		remaining,
		remainingPercent,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function fixedPointToCents(value: number): number {
	const cents = value / FIXED_POINT_CENTS;
	if (cents > 0 && cents < 1) return 1;
	return Math.round(cents);
}

function money(value: unknown): { cents: number; currency: string } | null {
	if (!isRecord(value)) return null;
	const cents = integer(value["priceInCents"]);
	if (cents === undefined) return null;
	return {
		cents,
		currency: typeof value["currency"] === "string" && value["currency"].length > 0 ? value["currency"] : "",
	};
}

function boosterWallet(value: unknown): KimiBoosterWallet | null {
	if (!isRecord(value)) return null;
	const balance = value["balance"];
	if (!isRecord(balance) || balance["type"] !== "BOOSTER") return null;
	const amount = integer(balance["amount"]);
	if (amount === undefined || amount <= 0) return null;
	const amountLeft = integer(balance["amountLeft"]);
	const monthlyLimit = money(value["monthlyChargeLimit"]);
	const monthlyUsed = money(value["monthlyUsed"]);
	return {
		balanceCents: amountLeft === undefined ? 0 : fixedPointToCents(amountLeft),
		totalCents: fixedPointToCents(amount),
		monthlyChargeLimitEnabled: value["monthlyChargeLimitEnabled"] === true,
		monthlyChargeLimitCents: monthlyLimit?.cents ?? 0,
		monthlyUsedCents: monthlyUsed?.cents ?? 0,
		currency: monthlyLimit?.currency || monthlyUsed?.currency || "USD",
	};
}

/** Read one window of the normalized projection (`{duration, unit}`). */
function normalizedWindow(value: unknown): KimiUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const duration = integer(value["duration"]);
	const unit = normalizeUnit(
		value["unit"] === "minute"
			? "TIME_UNIT_MINUTE"
			: value["unit"] === "hour"
				? "TIME_UNIT_HOUR"
				: value["unit"] === "day"
					? "TIME_UNIT_DAY"
					: value["unit"] === "week"
						? "TIME_UNIT_WEEK"
						: value["unit"],
	);
	return duration === undefined || duration <= 0 || unit === undefined ? undefined : { duration, unit };
}

/** Read one quota row of the already-normalized {@link KimiUsage} projection. */
function normalizedRow(value: unknown): KimiUsageRow | undefined {
	if (!isRecord(value)) return undefined;
	const used = integer(value["used"]);
	const limit = integer(value["limit"]);
	if (used === undefined || limit === undefined) return undefined;
	const name = nameFrom(value);
	const window = normalizedWindow(value["window"]);
	const resetAt = resetAtFrom(value) ?? normalizedResetAt(value["resetAt"]);
	return {
		...(name === undefined ? {} : { name }),
		...(window === undefined ? {} : { window }),
		used: Math.max(0, used),
		limit: Math.max(0, limit),
		remaining: Math.max(0, integer(value["remaining"]) ?? Math.max(0, limit - used)),
		remainingPercent: Math.max(0, Math.min(100, integer(value["remainingPercent"]) ?? 0)),
		...(resetAt === undefined ? {} : { resetAt }),
	};
}

/**
 * Whether a payload is already this module's normalized {@link KimiUsage}
 * projection rather than the provider's raw `/usages` document. The plugin's
 * own `GET /kimi/usage` and `GET /oauth/usage` routes serve the normalized
 * projection, so a second parse must pass it through instead of emptying it.
 */
function isNormalizedKimiUsage(payload: Record<string, unknown>): boolean {
	if (typeof payload["fetchedAt"] === "number") return true;
	if (!Array.isArray(payload["limits"]) || payload["limits"].length === 0) return false;
	return payload["limits"].every(
		(item) => isRecord(item) && item["detail"] === undefined && typeof item["used"] === "number",
	);
}

/** Pass an already-normalized {@link KimiUsage} projection through unchanged. */
function adoptNormalizedKimiUsage(payload: Record<string, unknown>): KimiUsage {
	const summary = normalizedRow(payload["summary"]);
	const limits: KimiUsageRow[] = [];
	if (Array.isArray(payload["limits"])) {
		for (const item of payload["limits"]) {
			const row = normalizedRow(item);
			if (row !== undefined) limits.push(row);
		}
	}
	const extra = payload["extraUsage"];
	const fetchedAt = integer(payload["fetchedAt"]);
	return {
		summary: summary ?? null,
		limits,
		extraUsage:
			isRecord(extra) &&
			typeof extra["balanceCents"] === "number" &&
			typeof extra["totalCents"] === "number" &&
			typeof extra["currency"] === "string"
				? {
						balanceCents: extra["balanceCents"],
						totalCents: extra["totalCents"],
						monthlyChargeLimitEnabled: extra["monthlyChargeLimitEnabled"] === true,
						monthlyChargeLimitCents: integer(extra["monthlyChargeLimitCents"]) ?? 0,
						monthlyUsedCents: integer(extra["monthlyUsedCents"]) ?? 0,
						currency: extra["currency"],
					}
				: null,
		fetchedAt: fetchedAt ?? Date.now(),
	};
}

/** Normalize official /usages response payload into clean typed structure. */
export function parseKimiUsage(payload: unknown, fetchedAt = Date.now()): KimiUsage {
	if (!isRecord(payload)) {
		return { summary: null, limits: [], extraUsage: null, fetchedAt };
	}
	if (isNormalizedKimiUsage(payload)) return adoptNormalizedKimiUsage(payload);
	let summary = usageRow(payload["usage"]);
	if (summary !== null && summary.window === undefined) {
		summary = { ...summary, window: { duration: 1, unit: "week" } };
	}
	const limits: KimiUsageRow[] = [];
	const rawLimits = payload["limits"];
	if (Array.isArray(rawLimits)) {
		for (const item of rawLimits) {
			if (!isRecord(item)) continue;
			const row = usageRow(item["detail"], {
				name: nameFrom(item),
				window: windowFrom(item["window"]),
			});
			if (row !== null) limits.push(row);
		}
	}
	return {
		summary,
		limits,
		extraUsage: boosterWallet(payload["boosterWallet"]),
		fetchedAt,
	};
}

export function kimiAuthFromSession(session: {
	resolveAccessToken(): Promise<string | undefined>;
	invalidateAccessToken(): Promise<void>;
}): KimiAuthSession {
	return {
		resolve: async () => {
			const accessToken = await session.resolveAccessToken();
			return accessToken === undefined || accessToken.length === 0 ? undefined : { accessToken };
		},
		invalidate: () => session.invalidateAccessToken(),
	};
}

/**
 * Creates a cached, concurrency-deduplicated Kimi Code usage reader.
 */
export function createKimiUsageReader(options: KimiUsageReaderOptions): KimiUsageReader {
	const auth = options.auth;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const url = options.url ?? KIMI_USAGE_URL;
	const ttlMs = options.ttlMs ?? DEFAULT_KIMI_USAGE_TTL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_KIMI_USAGE_TIMEOUT_MS;

	let cached: KimiUsage | undefined;
	let inFlight: Promise<KimiUsage> | undefined;
	let epoch = 0;

	const fetchUsage = async (signal?: AbortSignal, retryOnAuth = true): Promise<KimiUsage> => {
		signal?.throwIfAborted();
		const resolution = await auth.resolve();
		if (!resolution?.accessToken) {
			throw new Error("Kimi Code subscription is not connected");
		}

		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

		const response = await fetchImpl(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${resolution.accessToken}`,
				Accept: "application/json",
			},
			redirect: "error",
			signal: requestSignal,
		});

		if (response.status === 401 && retryOnAuth) {
			await auth.invalidate();
			return fetchUsage(signal, false);
		}

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error("Kimi Code subscription sign-in needs to be renewed");
			}
			if (response.status === 402 || response.status === 403) {
				throw new Error("Kimi Code subscription quota is currently unavailable");
			}
			throw new Error(`Could not read Kimi Code subscription usage (HTTP ${String(response.status)})`);
		}

		const payload: unknown = await response.json();
		return parseKimiUsage(payload, now());
	};

	return {
		read({ force = false, signal } = {}) {
			if (!force && cached !== undefined && now() - cached.fetchedAt < ttlMs) {
				return Promise.resolve(cached);
			}
			if (!force && inFlight !== undefined) return inFlight;
			if (force) epoch += 1;
			const started = epoch;
			const current = fetchUsage(signal)
				.then((value) => {
					if (started === epoch) cached = value;
					return value;
				})
				.finally(() => {
					if (inFlight === current) inFlight = undefined;
				});
			inFlight = current;
			return current;
		},
		clear() {
			epoch += 1;
			cached = undefined;
			inFlight = undefined;
		},
	};
}
