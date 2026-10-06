/**
 * WorkBuddy routes: the owner-request guard, method handling, and the fact that
 * the check-in is READ-THEN-CLAIM so an already-claimed day never spends a
 * second grant.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyCredentialStore } from "../src/workbuddy-auth.ts";
import { createWorkBuddyRouteSurface, registerWorkBuddyRoutes } from "../src/workbuddy-routes.ts";
import { WorkBuddySession } from "../src/workbuddy-session.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workbuddy-routes-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function desktopDocument(domain = "www.workbuddy.cn"): string {
	return JSON.stringify({
		auth: {
			accessToken: "access-desktop",
			refreshToken: "refresh-desktop",
			expiresAt: Date.now() + 3_600_000,
			lastRefreshTime: Date.now(),
			domain,
		},
		account: { uid: "uid-1", uin: "100000000001", nickname: "Buddy" },
	});
}

/** A session over a real store, with the catalog fetch stubbed. */
async function fixture(domain = "www.workbuddy.cn"): Promise<{
	store: WorkBuddyCredentialStore;
	session: WorkBuddySession;
}> {
	const dir = await tempDir();
	await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument(domain));
	const store = new WorkBuddyCredentialStore({
		authDirs: [dir],
		ownPath: join(dir, "own.json"),
		refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
	});
	const session = new WorkBuddySession(store, undefined, join(dir, "models.json"));
	return { store, session };
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("createWorkBuddyRouteSurface", () => {
	it("reports the account, catalog and check-in state without leaking a token", async () => {
		const { store, session } = await fixture();
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(url);
			if (url.includes("checkin-activity-status")) {
				return jsonResponse({
					code: 0,
					msg: "OK",
					data: { active: true, today_checked_in: false, streak_days: 4, daily_credit: 100, today_credit: 100 },
				});
			}
			if (url.includes("get-user-resource")) {
				return jsonResponse({
					code: 0,
					msg: "OK",
					data: {
						Response: {
							Data: {
								TotalCount: 1,
								Accounts: [{ AccountId: 1, CapacityType: 4, CapacityRemain: 500, CapacitySize: 500 }],
							},
						},
					},
				});
			}
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					models: [{ id: "glm-5.3", maxInputTokens: 1_000_000, maxOutputTokens: 64_000, credits: "x0.79 credits" }],
				},
			});
		});
		const surface = createWorkBuddyRouteSurface({ session, store });
		const view = await surface.snapshot();
		expect(view.provider.state).toBe("signed-in");
		expect(view.provider.region).toBe("cn");
		expect(view.desktopFilePresent).toBe(true);
		expect(view.checkinSupported).toBe(true);
		expect(view.checkin?.streakDays).toBe(4);
		expect(view.credits?.totalRemaining).toBe(500);
		// Nothing in the payload may be credential material.
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain("access-desktop");
		expect(serialized).not.toContain("refresh-desktop");
		// A snapshot reports state; only an explicit refresh re-reads the roster.
		expect(calls.some((url) => url.endsWith("/v3/config"))).toBe(false);
		await surface.refresh();
		expect(calls.some((url) => url.endsWith("/v3/config"))).toBe(true);
	});

	it("reports the region as global and withholds check-in for an international account", async () => {
		const { store, session } = await fixture("www.workbuddy.ai");
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.includes("get-user-resource")) return jsonResponse({ code: 0, msg: "OK", data: {} });
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] },
			});
		});
		const surface = createWorkBuddyRouteSurface({ session, store });
		const view = await surface.snapshot();
		expect(view.provider.region).toBe("global");
		expect(view.checkinSupported).toBe(false);
		// No check-in campaign, so no check-in call at all.
		expect(view.checkin).toBeUndefined();
	});

	it("claims only when the day is still unclaimed, then re-reads the status", async () => {
		const { store, session } = await fixture();
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(url);
			if (url.includes("daily-checkin")) {
				return jsonResponse({ code: 0, msg: "OK", data: { credit: 100, streak_days: 5, is_streak_day: true } });
			}
			if (url.includes("checkin-activity-status")) {
				const claimed = calls.filter((entry) => entry.includes("daily-checkin")).length > 0;
				return jsonResponse({
					code: 0,
					msg: "OK",
					data: { active: true, today_checked_in: claimed, streak_days: 5, today_credit: claimed ? 100 : 0 },
				});
			}
			if (url.includes("get-user-resource")) return jsonResponse({ code: 0, msg: "OK", data: {} });
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] },
			});
		});
		const surface = createWorkBuddyRouteSurface({ session, store });
		const result = (await surface.checkin()) as {
			alreadyCheckedIn: boolean;
			claim?: { credit: number };
			checkin: { todayCheckedIn: boolean };
		};
		expect(result.alreadyCheckedIn).toBe(false);
		expect(result.claim?.credit).toBe(100);
		expect(result.checkin.todayCheckedIn).toBe(true);
		// Exactly one read before and one after: never a bare claim.
		expect(calls.filter((url) => url.includes("daily-checkin"))).toHaveLength(1);
	});

	it("does NOT claim a reward that was already taken today", async () => {
		const { store, session } = await fixture();
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(url);
			if (url.includes("checkin-activity-status")) {
				return jsonResponse({
					code: 0,
					msg: "OK",
					data: { active: true, today_checked_in: true, streak_days: 5, today_credit: 100 },
				});
			}
			if (url.includes("get-user-resource")) return jsonResponse({ code: 0, msg: "OK", data: {} });
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] },
			});
		});
		const surface = createWorkBuddyRouteSurface({ session, store });
		const result = (await surface.checkin()) as { alreadyCheckedIn: boolean };
		expect(result.alreadyCheckedIn).toBe(true);
		// The grant endpoint must never have been reached.
		expect(calls.some((url) => url.includes("daily-checkin"))).toBe(false);
	});

	it("refuses to claim for a region with no check-in", async () => {
		const { store, session } = await fixture("www.workbuddy.ai");
		const surface = createWorkBuddyRouteSurface({ session, store });
		await expect(surface.checkin()).rejects.toThrow(/region/iu);
	});

	it("reports billing failures per section instead of failing the whole snapshot", async () => {
		const { store, session } = await fixture();
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.includes("checkin-activity-status")) throw new Error("billing down");
			if (url.includes("get-user-resource")) throw new Error("billing down");
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "glm-5.3", maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }] },
			});
		});
		const surface = createWorkBuddyRouteSurface({ session, store });
		const view = await surface.snapshot();
		// A billing outage must not hide the model list, and vice versa.
		expect(view.catalog.models.length).toBeGreaterThan(0);
		expect(view.checkinError).toBe("billing down");
		expect(view.creditsError).toBe("billing down");
	});

	it("persists selection and budgets through the surface", async () => {
		const { store, session } = await fixture();
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "glm-5.3", maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }] },
			}),
		);
		const surface = createWorkBuddyRouteSurface({ session, store });
		await surface.snapshot();
		const selected = await surface.setModels({ selected: ["glm-5.3"] });
		expect(selected.catalog.selectionExplicit).toBe(true);
		const budgeted = await surface.setBudget({ modelId: "glm-5.3", budget: 200_000 });
		expect(budgeted.catalog.contextBudgets).toEqual({ "glm-5.3": 200_000 });
		const model = budgeted.catalog.models.find((entry) => entry.id === "glm-5.3");
		expect(model?.contextWindow).toBe(200_000);
		// The native window is still reported, so the card can show both.
		expect(model?.nativeContextWindow).toBe(1_000_000);
	});

	it("rejects a blank model id on a budget write", async () => {
		const { store, session } = await fixture();
		const surface = createWorkBuddyRouteSurface({ session, store });
		await expect(surface.setBudget({ modelId: "  ", budget: 1000 })).rejects.toThrow(/non-empty/iu);
	});

	it("reports EVERY roster model with an enabled flag, so a disabled one can be re-enabled", async () => {
		// Regression: the route used to filter the roster to the visible models, so
		// switching one off deleted its own checkbox and made the change permanent.
		const { store, session } = await fixture();
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					models: [
						{ id: "keep", maxInputTokens: 100_000, maxOutputTokens: 1000 },
						{ id: "drop", maxInputTokens: 100_000, maxOutputTokens: 1000 },
					],
				},
			}),
		);
		const surface = createWorkBuddyRouteSurface({ session, store });
		await surface.refresh();

		const before = await surface.snapshot({ checkin: false });
		expect(before.catalog.models.map((model) => model.id).sort()).toEqual(["drop", "keep"]);
		expect(before.catalog.models.every((model) => model.enabled)).toBe(true);

		// Switch one off...
		const disabled = await surface.setModels({ selected: ["keep"] });
		expect(disabled.catalog.enabledModelIds).toEqual(["keep"]);
		// ...and it is STILL listed, merely not enabled, so it can come back.
		const dropped = disabled.catalog.models.find((model) => model.id === "drop");
		expect(dropped).toBeDefined();
		expect(dropped?.enabled).toBe(false);
		expect(disabled.catalog.models.find((model) => model.id === "keep")?.enabled).toBe(true);
		// The served roster is narrowed even though the reported one is not.
		expect(session.visibleModels().map((model) => model.id)).toEqual(["keep"]);

		// Re-enabling restores it.
		const reenabled = await surface.setModels({ selected: ["keep", "drop"] });
		expect(reenabled.catalog.models.find((model) => model.id === "drop")?.enabled).toBe(true);
	});

	it("lists discovered auth files and reports the override in force", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, "workbuddy-desktop.info"), desktopDocument());
		await writeFile(
			join(dir, "workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info"),
			desktopDocument("www.workbuddy.ai"),
		);
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
		});
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ code: 0, msg: "OK", data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] } }),
		);
		const session = new WorkBuddySession(store, undefined, join(dir, "models.json"));
		const surface = createWorkBuddyRouteSurface({ session, store });

		const initial = await surface.snapshot({ checkin: false });
		expect(initial.authFiles.length).toBeGreaterThanOrEqual(2);
		expect(initial.authFileOverride).toBeUndefined();
		// Only the live file is in the probe path; the backup is listed as a choice.
		expect(initial.authFiles.filter((file) => file.active).map((file) => file.path)).toEqual([
			join(dir, "workbuddy-desktop.info"),
		]);
		expect(initial.authFiles.some((file) => file.readable && file.region === "global")).toBe(true);
		expect(JSON.stringify(initial.authFiles)).not.toContain("access-desktop");
	});

	it("switches to a discovered auth file and back to the defaults", async () => {
		const dir = await tempDir();
		const livePath = join(dir, "workbuddy-desktop.info");
		await writeFile(livePath, desktopDocument());
		const backupPath = join(dir, "workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info");
		await writeFile(backupPath, desktopDocument("www.workbuddy.ai"));
		const store = new WorkBuddyCredentialStore({
			authDirs: [dir],
			ownPath: join(dir, "own.json"),
			refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
		});
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ code: 0, msg: "OK", data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] } }),
		);
		const session = new WorkBuddySession(store, undefined, join(dir, "models.json"));
		const surface = createWorkBuddyRouteSurface({ session, store });

		// Auto mode scans the live file AND its siblings.
		const initial = await surface.snapshot({ checkin: false });
		expect(initial.authFileOverride).toBeUndefined();
		expect((await store.diagnose()).tried).toContain(backupPath);

		// Pinning the international backup changes the region AND stops the live
		// file from being consulted at all: the choice must mean what it says.
		const switched = await surface.setAuthFile(backupPath);
		expect(switched.authFileOverride).toBe(backupPath);
		expect(switched.provider.region).toBe("global");
		const pinned = (await store.diagnose()).tried;
		expect(pinned).toContain(backupPath);
		expect(pinned).not.toContain(livePath);

		// Back to the defaults, which is its own choice rather than a re-pin and
		// restores the full scan.
		const restored = await surface.setAuthFile(undefined);
		expect(restored.authFileOverride).toBeUndefined();
		expect((await store.diagnose()).tried).toContain(backupPath);
	});

	it("persists the auth-file choice so it survives a restart", async () => {
		// The store holds the override in memory only. Without persisting it, a
		// restart silently reverts discovery to the platform default, so the user's
		// selection appears to have been ignored and their account changes back.
		const dir = await tempDir();
		const livePath = join(dir, "workbuddy-desktop.info");
		await writeFile(livePath, desktopDocument());
		const backupPath = join(dir, "workbuddy-desktop.2026-01-01T00-00-00-000Z.1.a.info");
		await writeFile(backupPath, desktopDocument("www.workbuddy.ai"));
		const cacheFile = join(dir, "models.json");
		const makeStore = () =>
			new WorkBuddyCredentialStore({
				authDirs: [dir],
				ownPath: join(dir, "own.json"),
				refresh: async () => ({ accessToken: "rotated", expiresInSec: 3600 }),
			});
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ code: 0, msg: "OK", data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 }] } }),
		);

		const first = new WorkBuddySession(makeStore(), undefined, cacheFile);
		const firstSurface = createWorkBuddyRouteSurface({ session: first, store: first.store });
		await firstSurface.setAuthFile(backupPath);
		expect(first.authFile()).toBe(backupPath);

		// A fresh store + session, as after a restart: the pin must come back from
		// disk, and it must be restored BEFORE the credential is read so the first
		// request cannot answer from the wrong account.
		const secondStore = makeStore();
		const second = new WorkBuddySession(secondStore, undefined, cacheFile);
		await second.loadCachedState();
		expect(second.authFile()).toBe(backupPath);
		expect((await secondStore.diagnose()).tried).toContain(backupPath);
		expect((await secondStore.diagnose()).tried).not.toContain(livePath);

		// Returning to the platform defaults is persisted as an ABSENT field, so
		// the next start must not resurrect the old pin.
		const secondSurface = createWorkBuddyRouteSurface({ session: second, store: secondStore });
		await secondSurface.setAuthFile(undefined);
		const thirdStore = makeStore();
		const third = new WorkBuddySession(thirdStore, undefined, cacheFile);
		await third.loadCachedState();
		expect(third.authFile()).toBeUndefined();
		expect((await thirdStore.diagnose()).tried).toContain(livePath);
	});

	it("refuses an auth file it did not discover", async () => {
		const { store, session } = await fixture();
		const surface = createWorkBuddyRouteSurface({ session, store });
		// An unrestricted path would turn the switch into an arbitrary file read.
		await expect(surface.setAuthFile(join(tmpdir(), "not-a-real-workbuddy-file.info"))).rejects.toThrow(
			/not one of the discovered/iu,
		);
	});
});

describe("registerWorkBuddyRoutes", () => {
	/** A minimal registry capturing registered handlers. */
	function registry(): {
		ctx: Parameters<typeof registerWorkBuddyRoutes>[0];
		handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
		dispose: () => void;
	} {
		const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
		let onDispose: () => void = () => undefined;
		const ctx = {
			webServer: {
				register(route: {
					path: string;
					handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
				}) {
					handlers.set(route.path, route.handler);
					return () => handlers.delete(route.path);
				},
			},
			effect(callback: () => () => void) {
				onDispose = callback();
				return undefined;
			},
		} as unknown as Parameters<typeof registerWorkBuddyRoutes>[0];
		return { ctx, handlers, dispose: () => onDispose() };
	}

	/** A response double recording status and body. */
	function response(): { res: ServerResponse; status: () => number; body: () => string } {
		let code = 0;
		let text = "";
		const res = {
			writeHead(status: number) {
				code = status;
				return this;
			},
			end(chunk?: unknown) {
				text = chunk === undefined ? "" : String(chunk);
				return this;
			},
		} as unknown as ServerResponse;
		return { res, status: () => code, body: () => text };
	}

	it("registers exactly the three WorkBuddy routes", async () => {
		const { store, session } = await fixture();
		const { ctx, handlers } = registry();
		registerWorkBuddyRoutes(ctx, { session, store });
		expect([...handlers.keys()].sort()).toEqual([
			"/plugins/dsh-grok-build/workbuddy/checkin",
			"/plugins/dsh-grok-build/workbuddy/models",
			"/plugins/dsh-grok-build/workbuddy/status",
		]);
	});

	it("rejects a wrong method with 405", async () => {
		const { store, session } = await fixture();
		const { ctx, handlers } = registry();
		registerWorkBuddyRoutes(ctx, { session, store });
		const { res, status } = response();
		await handlers.get("/plugins/dsh-grok-build/workbuddy/checkin")?.({ method: "GET" } as IncomingMessage, res);
		expect(status()).toBe(405);
	});

	it("rejects a non-owner request with 403", async () => {
		const { store, session } = await fixture();
		const { ctx, handlers } = registry();
		registerWorkBuddyRoutes(ctx, {
			session,
			store,
			ownerRequestPolicy: { authorize: () => ({ authorized: false }), diagnostics: () => [] } as never,
		});
		const { res, status } = response();
		await handlers.get("/plugins/dsh-grok-build/workbuddy/status")?.({ method: "GET" } as IncomingMessage, res);
		expect(status()).toBe(403);
	});

	it("releases every route on disposal", async () => {
		const { store, session } = await fixture();
		const { ctx, handlers, dispose } = registry();
		registerWorkBuddyRoutes(ctx, { session, store });
		expect(handlers.size).toBe(3);
		dispose();
		expect(handlers.size).toBe(0);
	});
});
