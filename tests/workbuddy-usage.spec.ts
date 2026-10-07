/**
 * WorkBuddy usage reader: the projection the conversation-window badge renders.
 *
 * The reader is a cache in front of the billing endpoint, so the tests pin the
 * three properties the badge depends on: a signed-out account yields nothing, a
 * second read inside the TTL does not spend another request, and the projection
 * never carries credential material.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyCredentialStore } from "../src/workbuddy-auth.ts";
import { createWorkBuddyUsageReader } from "../src/workbuddy-usage.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workbuddy-usage-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function desktopDocument(domain = "www.workbuddy.cn"): string {
	return JSON.stringify({
		auth: {
			accessToken: "SECRET-ACCESS-TOKEN",
			refreshToken: "SECRET-REFRESH-TOKEN",
			expiresAt: Date.now() + 3_600_000,
			lastRefreshTime: Date.now(),
			domain,
		},
		account: { uid: "uid-1", uin: "100000000001", nickname: "Buddy" },
	});
}

async function storeWithCredential(domain = "www.workbuddy.cn"): Promise<WorkBuddyCredentialStore> {
	const dir = await tempDir();
	await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument(domain));
	return new WorkBuddyCredentialStore({
		authDirs: [dir],
		ownPath: join(dir, "own.json"),
		refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
	});
}

/** The billing envelope the credits reader unwraps. */
function creditsEnvelope(accounts: unknown[]): Response {
	return new Response(
		JSON.stringify({
			code: 0,
			msg: "OK",
			data: { Response: { Data: { TotalCount: accounts.length, Accounts: accounts } } },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

const MONTHLY_AND_GIFT = [
	{
		AccountId: 1,
		DealName: "monthly",
		PackageName: "Personal",
		CapacityType: 4,
		CapacityUnit: "credits",
		CapacityRemain: 500,
		CapacitySize: 500,
		CycleCapacityRemain: 62,
		CycleCapacitySize: 500,
	},
	{ AccountId: 2, DealName: "gift", CapacityType: 1, CapacityUnit: "credits", CapacityRemain: 100, CapacitySize: 100 },
];

describe("createWorkBuddyUsageReader", () => {
	it("projects the account name and the REMAINING credit, never rate-limit windows", async () => {
		const store = await storeWithCredential();
		vi.stubGlobal("fetch", async () => creditsEnvelope(MONTHLY_AND_GIFT));
		const reader = createWorkBuddyUsageReader({ store });
		const usage = await reader.read();
		expect(usage).toMatchObject({ account: "Buddy", region: "cn", totalCount: 2, totalRemaining: 162 });
		expect(usage?.fetchedAt).toBeTypeOf("number");
	});

	it("carries no credential material", async () => {
		const store = await storeWithCredential();
		vi.stubGlobal("fetch", async () => creditsEnvelope(MONTHLY_AND_GIFT));
		const reader = createWorkBuddyUsageReader({ store });
		const serialized = JSON.stringify(await reader.read());
		expect(serialized).not.toContain("SECRET-ACCESS-TOKEN");
		expect(serialized).not.toContain("SECRET-REFRESH-TOKEN");
		expect(serialized).not.toContain("workbuddy-desktop.info");
	});

	it("reports nothing while signed out, without calling the billing endpoint", async () => {
		const dir = await tempDir();
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const usage = await createWorkBuddyUsageReader({ store }).read();
		expect(usage).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("serves a second read inside the TTL from cache", async () => {
		const store = await storeWithCredential();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return creditsEnvelope(MONTHLY_AND_GIFT);
		});
		let now = 1_000_000;
		const reader = createWorkBuddyUsageReader({ store, now: () => now, ttlMs: 60_000 });
		await reader.read();
		now += 30_000;
		await reader.read();
		expect(calls).toBe(1);
		// Past the TTL the billing endpoint is consulted again.
		now += 60_000;
		await reader.read();
		expect(calls).toBe(2);
	});

	it("single-flights concurrent reads into one billing request", async () => {
		const store = await storeWithCredential();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return creditsEnvelope(MONTHLY_AND_GIFT);
		});
		const reader = createWorkBuddyUsageReader({ store });
		const [a, b, c] = await Promise.all([reader.read(), reader.read(), reader.read()]);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
		expect(b).toEqual(c);
	});

	it("drops the memoized answer on clear()", async () => {
		const store = await storeWithCredential();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return creditsEnvelope(MONTHLY_AND_GIFT);
		});
		const reader = createWorkBuddyUsageReader({ store });
		await reader.read();
		reader.clear();
		await reader.read();
		expect(calls).toBe(2);
	});

	it("does not cache a failure, so a recovered upstream is seen immediately", async () => {
		const store = await storeWithCredential();
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			if (calls === 1) throw new Error("billing down");
			return creditsEnvelope(MONTHLY_AND_GIFT);
		});
		const reader = createWorkBuddyUsageReader({ store });
		await expect(reader.read()).rejects.toThrow(/billing down/u);
		await expect(reader.read()).resolves.toMatchObject({ totalRemaining: 162 });
	});

	it("maps the international domain to the global region", async () => {
		const store = await storeWithCredential("www.workbuddy.ai");
		vi.stubGlobal("fetch", async () => creditsEnvelope(MONTHLY_AND_GIFT));
		const usage = await createWorkBuddyUsageReader({ store }).read();
		expect(usage?.region).toBe("global");
	});
});
