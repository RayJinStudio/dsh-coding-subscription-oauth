/**
 * WorkBuddy usage projection for the conversation-window usage badge.
 *
 * The badge is a browser poller: it reads the plugin's aggregate usage route on
 * an interval, so a reader that went to the billing endpoint on every call would
 * spend a request per open session per tick. This reader therefore memoizes its
 * successful answer for a TTL and single-flights concurrent calls, exactly like
 * the Codex and Kimi readers, and reports `undefined` while signed out so the
 * aggregate route can mark the provider unsupported.
 *
 * The projection is secret-free by construction: it carries the account's
 * DISPLAY name (the same nickname the settings card shows) and credit totals,
 * never the access token, the refresh token, or the credential's file path.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-usage
 */

import type { WorkBuddyCredentialStore } from "./workbuddy-auth.ts";
import { workbuddyRegionOf } from "./workbuddy-auth.ts";
import { fetchWorkBuddyCredits } from "./workbuddy-upstream.ts";

/** How long one credits answer stays fresh for the badge. */
export const DEFAULT_WORKBUDDY_USAGE_TTL_MS = 60_000;
/** Upper bound on one billing read, so a hung upstream cannot stall the poll. */
export const DEFAULT_WORKBUDDY_USAGE_TIMEOUT_MS = 20_000;

/** The secret-free usage projection the badge renders. */
export interface WorkBuddyUsage {
	/** Account display name; omitted when the credential carries none. */
	account?: string;
	region?: "cn" | "global";
	/** Number of credit packages the account holds. */
	totalCount: number;
	/** Credits actually left to spend, summed across packages. */
	totalRemaining: number;
	fetchedAt: number;
}

export interface WorkBuddyUsageReaderOptions {
	store: WorkBuddyCredentialStore;
	now?: () => number;
	ttlMs?: number;
	timeoutMs?: number;
}

export interface WorkBuddyUsageReader {
	/** The current projection, or `undefined` when signed out. */
	read(): Promise<WorkBuddyUsage | undefined>;
	/** Drop the memoized answer, so the next read goes upstream. */
	clear(): void;
}

/**
 * Creates a cached, concurrency-deduplicated WorkBuddy usage reader.
 *
 * A failed read is NOT cached: the badge is an enhancement, and memoizing an
 * outage would keep the provider hidden for a whole TTL after the upstream
 * recovered.
 */
export function createWorkBuddyUsageReader(options: WorkBuddyUsageReaderOptions): WorkBuddyUsageReader {
	const { store } = options;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DEFAULT_WORKBUDDY_USAGE_TTL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_WORKBUDDY_USAGE_TIMEOUT_MS;

	let cached: WorkBuddyUsage | undefined;
	let inFlight: Promise<WorkBuddyUsage | undefined> | undefined;

	const read = async (): Promise<WorkBuddyUsage | undefined> => {
		const status = await store.status();
		if (status.state !== "signed-in") return undefined;
		const fetchedAt = now();
		if (cached !== undefined && fetchedAt - cached.fetchedAt < ttlMs) return cached;
		const credential = await store.resolve();
		const credits = await fetchWorkBuddyCredits(credential, AbortSignal.timeout(timeoutMs));
		const usage: WorkBuddyUsage = {
			...(status.nickname === undefined || status.nickname === "" ? {} : { account: status.nickname }),
			...(status.domain === undefined ? {} : { region: workbuddyRegionOf(status.domain) }),
			totalCount: credits.totalCount,
			totalRemaining: credits.totalRemaining,
			fetchedAt,
		};
		cached = usage;
		return usage;
	};

	return {
		read: () => {
			// Single-flight: the badge, the settings card and a second open session
			// can all ask within one TTL, and none of them should queue a request.
			if (inFlight === undefined) {
				inFlight = read().finally(() => {
					inFlight = undefined;
				});
			}
			return inFlight;
		},
		clear: () => {
			cached = undefined;
		},
	};
}
