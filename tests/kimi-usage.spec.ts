import { describe, expect, it, vi } from "vitest";
import { createKimiUsageReader, parseKimiUsage } from "../src/kimi-usage.ts";

const samplePayload = {
	usage: { used: "400", limit: "1000", resetTime: "2026-08-03T05:20:51Z" },
	limits: [
		{
			name: "Rate limit",
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { used: "25", limit: "100", resetTime: "2026-07-27T10:00:00Z" },
		},
	],
	boosterWallet: {
		balance: { type: "BOOSTER", amount: "100000000", amountLeft: "45000000" },
		monthlyChargeLimitEnabled: true,
		monthlyChargeLimit: { priceInCents: "2000", currency: "CNY" },
		monthlyUsed: { priceInCents: "600", currency: "CNY" },
	},
};

describe("parseKimiUsage", () => {
	it("normalizes official /usages payload with summary, limits, and booster wallet", () => {
		const parsed = parseKimiUsage(samplePayload, 1700000000);
		expect(parsed.summary).toEqual({
			name: undefined,
			window: { duration: 1, unit: "week" },
			used: 400,
			limit: 1000,
			remaining: 600,
			remainingPercent: 60,
			resetAt: "2026-08-03T05:20:51Z",
		});
		expect(parsed.limits).toEqual([
			{
				name: "Rate limit",
				window: { duration: 5, unit: "hour" },
				used: 25,
				limit: 100,
				remaining: 75,
				remainingPercent: 75,
				resetAt: "2026-07-27T10:00:00Z",
			},
		]);
		expect(parsed.extraUsage).toEqual({
			balanceCents: 45,
			totalCents: 100,
			monthlyChargeLimitEnabled: true,
			monthlyChargeLimitCents: 2000,
			monthlyUsedCents: 600,
			currency: "CNY",
		});
		expect(parsed.fetchedAt).toBe(1700000000);
	});

	it("handles empty or malformed payload gracefully", () => {
		const parsed = parseKimiUsage(null);
		expect(parsed.summary).toBeNull();
		expect(parsed.limits).toEqual([]);
		expect(parsed.extraUsage).toBeNull();
	});

	it("adopts the normalized projection this plugin's own routes serve", () => {
		// Shape served by GET /plugins/dsh-grok-build/kimi/usage (and the kimi
		// share of /oauth/usage): already normalized, epoch-ms fetchedAt.
		const parsed = parseKimiUsage({
			summary: {
				used: 1,
				limit: 100,
				remaining: 99,
				remainingPercent: 99,
				resetAt: "2026-10-10T04:37:37.838304Z",
				window: { duration: 1, unit: "week" },
			},
			limits: [
				{
					window: { duration: 5, unit: "hour" },
					used: 4,
					limit: 100,
					remaining: 96,
					remainingPercent: 96,
					resetAt: "2026-10-04T11:37:37.838304Z",
				},
			],
			extraUsage: null,
			fetchedAt: 1_791_113_203_417,
		});
		expect(parsed.summary).toEqual({
			window: { duration: 1, unit: "week" },
			used: 1,
			limit: 100,
			remaining: 99,
			remainingPercent: 99,
			resetAt: "2026-10-10T04:37:37.838304Z",
		});
		expect(parsed.limits).toEqual([
			{
				window: { duration: 5, unit: "hour" },
				used: 4,
				limit: 100,
				remaining: 96,
				remainingPercent: 96,
				resetAt: "2026-10-04T11:37:37.838304Z",
			},
		]);
		expect(parsed.fetchedAt).toBe(1_791_113_203_417);
	});

	it("adopts a normalized projection that carries no fetchedAt stamp", () => {
		const parsed = parseKimiUsage({
			summary: null,
			limits: [{ used: 4, limit: 100, remaining: 96, remainingPercent: 96 }],
			extraUsage: {
				balanceCents: 45,
				totalCents: 100,
				monthlyChargeLimitEnabled: false,
				monthlyChargeLimitCents: 0,
				monthlyUsedCents: 0,
				currency: "CNY",
			},
		});
		expect(parsed.limits).toEqual([{ used: 4, limit: 100, remaining: 96, remainingPercent: 96 }]);
		expect(parsed.extraUsage).toEqual({
			balanceCents: 45,
			totalCents: 100,
			monthlyChargeLimitEnabled: false,
			monthlyChargeLimitCents: 0,
			monthlyUsedCents: 0,
			currency: "CNY",
		});
	});
});

describe("createKimiUsageReader", () => {
	it("sends Bearer token and caches within TTL", async () => {
		let clock = 1000;
		let requests = 0;
		let lastHeaders: Record<string, string> | undefined;

		const auth = {
			resolve: vi.fn(async () => ({ accessToken: "test-kimi-token" })),
			invalidate: vi.fn(async () => {}),
		};

		const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			requests += 1;
			lastHeaders = init?.headers as Record<string, string>;
			return new Response(JSON.stringify(samplePayload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const reader = createKimiUsageReader({
			auth,
			fetchImpl: mockFetch as unknown as typeof fetch,
			now: () => clock,
			ttlMs: 60_000,
		});

		const first = await reader.read();
		expect(requests).toBe(1);
		expect(first.summary?.used).toBe(400);
		expect(lastHeaders?.Authorization).toBe("Bearer test-kimi-token");

		// Second call within TTL should return cached
		const second = await reader.read();
		expect(requests).toBe(1);
		expect(second).toBe(first);

		// Advance clock past TTL
		clock += 61_000;
		const third = await reader.read();
		expect(requests).toBe(2);
		expect(third.summary?.used).toBe(400);
	});

	it("invalidates auth and retries once on 401", async () => {
		let callCount = 0;
		const auth = {
			resolve: vi.fn(async () => ({ accessToken: callCount === 0 ? "stale-token" : "fresh-token" })),
			invalidate: vi.fn(async () => {}),
		};

		const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			callCount += 1;
			const headers = init?.headers as Record<string, string>;
			if (headers?.Authorization === "Bearer stale-token") {
				return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
			}
			return new Response(JSON.stringify(samplePayload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const reader = createKimiUsageReader({
			auth,
			fetchImpl: mockFetch as unknown as typeof fetch,
		});

		const res = await reader.read();
		expect(auth.invalidate).toHaveBeenCalledTimes(1);
		expect(res.summary?.used).toBe(400);
	});
});
