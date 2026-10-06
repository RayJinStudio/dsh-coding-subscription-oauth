/**
 * WorkBuddy upstream: catalog parsing, host selection, check-in/credits
 * protocol, error classification, and the request-body normalization the
 * gateway requires.
 */
import { describe, expect, it, vi } from "vitest";
import type { WorkBuddyCredential } from "../src/workbuddy-auth.ts";
import {
	claimWorkBuddyCheckin,
	classifyWorkBuddyError,
	fetchWorkBuddyCatalog,
	fetchWorkBuddyCheckinStatus,
	fetchWorkBuddyCredits,
	parseWorkBuddyCreditMultiplier,
	parseWorkBuddyModel,
	parseWorkBuddyReasoning,
	prepareWorkBuddyChatBody,
	refreshWorkBuddyToken,
	selectWorkBuddyRoster,
	WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
	WorkBuddyUpstreamError,
	workbuddyBillingBase,
	workbuddyBillingHeaders,
	workbuddyChatBase,
	workbuddyChatHeaders,
	workbuddyCheckinSupported,
	workbuddyGlobalBase,
	workbuddyModelHeaders,
	workbuddyRefreshHeaders,
} from "../src/workbuddy-upstream.ts";

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
	return {
		accessToken: "token-a",
		refreshToken: "refresh-a",
		expiresAtMs: Date.now() + 3_600_000,
		domain: "www.workbuddy.cn",
		uid: "uid-1",
		source: "desktop",
		filePath: "/tmp/a.info",
		...overrides,
	};
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("host selection", () => {
	it("routes each international brand domain to its own gateway", () => {
		// Tokens are NOT interchangeable across the two brands, so the host must
		// follow the credential's own domain rather than a single constant.
		expect(workbuddyGlobalBase("www.workbuddy.ai")).toBe("https://www.workbuddy.ai");
		expect(workbuddyGlobalBase("www.codebuddy.ai")).toBe("https://www.codebuddy.ai");
		expect(workbuddyGlobalBase("codebuddy.ai")).toBe("https://www.codebuddy.ai");
	});

	it("sends cn accounts to the domestic chat host and a global account elsewhere", () => {
		expect(workbuddyChatBase(credential())).toBe("https://copilot.tencent.com");
		expect(workbuddyChatBase(credential({ domain: "www.workbuddy.ai" }))).toBe("https://www.workbuddy.ai");
		expect(workbuddyChatBase(credential({ domain: "www.codebuddy.ai" }))).toBe("https://www.codebuddy.ai");
	});

	it("keeps the billing host domestic for cn and on-brand for global", () => {
		expect(workbuddyBillingBase(credential())).toBe("https://www.codebuddy.cn");
		expect(workbuddyBillingBase(credential({ domain: "www.workbuddy.ai" }))).toBe("https://www.workbuddy.ai");
	});

	it("supports check-in only where the campaign exists", () => {
		expect(workbuddyCheckinSupported("cn")).toBe(true);
		expect(workbuddyCheckinSupported("global")).toBe(false);
	});
});

describe("credential headers", () => {
	it("states absent identity fields with the X-No-* convention", () => {
		const headers = workbuddyChatHeaders(credential({ uid: "", domain: "" }));
		expect(headers["X-No-User-Id"]).toBe("1");
		expect(headers["X-No-Department-Info"]).toBe("1");
		expect(headers["X-No-Enterprise-Id"]).toBe("1");
		expect(headers["X-User-Id"]).toBeUndefined();
		expect(headers["X-Domain"]).toBeUndefined();
	});

	it("carries the CLI identity on chat calls", () => {
		const headers = workbuddyChatHeaders(credential());
		expect(headers["User-Agent"]).toBe("CLI/2.63.2 CodeBuddy/2.63.2");
		expect(headers["X-Product"]).toBe("SaaS");
		expect(headers.Authorization).toBe("Bearer token-a");
	});

	it("NEVER puts the refresh token on a chat request", () => {
		// The reference marks this a security red line: only the refresh endpoint
		// may see the refresh token.
		expect(workbuddyChatHeaders(credential())["X-Refresh-Token"]).toBeUndefined();
		expect(JSON.stringify(workbuddyChatHeaders(credential()))).not.toContain("refresh-a");
	});

	it("puts the refresh token only on the refresh headers", () => {
		const headers = workbuddyRefreshHeaders(credential());
		expect(headers["X-Refresh-Token"]).toBe("refresh-a");
		expect(headers["X-Auth-Refresh-Source"]).toBe("workbuddy");
		// No bearer: the refresh call authenticates with the token header alone.
		expect(headers.Authorization).toBeUndefined();
	});

	it("keeps the model headers credential-shaped but bearer-free", () => {
		// pi-ai injects `Bearer <apiKey>` from the adapter resolver, so a second
		// copy here would be two sources for one header.
		const headers = workbuddyModelHeaders(credential());
		expect(headers.Authorization).toBeUndefined();
		expect(headers["X-User-Id"]).toBe("uid-1");
		expect(headers["X-Product"]).toBe("SaaS");
	});

	it("sends the thin billing header set, not the CLI chat set", () => {
		const headers = workbuddyBillingHeaders(credential());
		expect(headers.Authorization).toBe("Bearer token-a");
		expect(headers["User-Agent"]).toBeUndefined();
		expect(headers.Origin).toBeUndefined();
		expect(headers["X-Requested-With"]).toBeUndefined();
		expect(headers["X-Product"]).toBeUndefined();
		// Tenant mirrors enterprise when there is one, and is absent otherwise.
		expect(headers["X-Tenant-Id"]).toBeUndefined();
		expect(workbuddyBillingHeaders(credential({ enterpriseId: "e-1" }))["X-Tenant-Id"]).toBe("e-1");
	});
});

describe("parseWorkBuddyCreditMultiplier", () => {
	it("parses the observed spellings and refuses to guess", () => {
		expect(parseWorkBuddyCreditMultiplier("x0.79 credits")).toBe(0.79);
		expect(parseWorkBuddyCreditMultiplier("x0.05")).toBe(0.05);
		expect(parseWorkBuddyCreditMultiplier("x0.00 credits")).toBe(0);
		expect(parseWorkBuddyCreditMultiplier("x 1.62 credits")).toBe(1.62);
		expect(parseWorkBuddyCreditMultiplier("free")).toBeUndefined();
		expect(parseWorkBuddyCreditMultiplier(undefined)).toBeUndefined();
		expect(parseWorkBuddyCreditMultiplier(7)).toBeUndefined();
	});
});

describe("parseWorkBuddyReasoning", () => {
	it("passes the plural form through", () => {
		expect(parseWorkBuddyReasoning({ supportedEfforts: ["low", "high"], canDisableThinking: true })).toEqual({
			supportedEfforts: ["low", "high"],
			canDisableThinking: true,
		});
	});

	it("widens the singular effort form into the full ladder", () => {
		// Live models answer distinctly across the whole ladder, and think not at
		// all with no effort sent, so the declared value is a DEFAULT.
		expect(parseWorkBuddyReasoning({ effort: "high", summary: "auto" })).toEqual({
			supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
			defaultEffort: "high",
			canDisableThinking: true,
		});
	});

	it("keeps an unrecognized singular effort as the lone level", () => {
		expect(parseWorkBuddyReasoning({ effort: "turbo" })).toEqual({
			supportedEfforts: ["turbo"],
			defaultEffort: "turbo",
			canDisableThinking: true,
		});
	});

	it("degrades an unknown shape to undefined rather than inventing levels", () => {
		expect(parseWorkBuddyReasoning(undefined)).toBeUndefined();
		expect(parseWorkBuddyReasoning("high")).toBeUndefined();
		expect(parseWorkBuddyReasoning({})).toBeUndefined();
	});
});

describe("parseWorkBuddyModel", () => {
	const row = {
		id: "glm-5.3",
		name: "GLM-5.3",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		credits: "x0.79 credits",
		supportsImages: true,
		supportsToolCall: true,
		reasoning: { supportedEfforts: ["high"], canDisableThinking: true },
	};

	it("renames the token fields rather than converting them", () => {
		expect(parseWorkBuddyModel(row)).toMatchObject({
			id: "glm-5.3",
			name: "GLM-5.3",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			creditMultiplier: 0.79,
			supportsImages: true,
		});
	});

	it("drops rows without usable token limits, or that are disabled", () => {
		expect(parseWorkBuddyModel({ ...row, maxInputTokens: 0 })).toBeUndefined();
		expect(parseWorkBuddyModel({ ...row, maxOutputTokens: 0 })).toBeUndefined();
		expect(parseWorkBuddyModel({ ...row, disabled: true })).toBeUndefined();
		expect(parseWorkBuddyModel({ ...row, id: "" })).toBeUndefined();
		expect(parseWorkBuddyModel({ maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined();
	});

	it("lets disabledMultimodal veto the platform image flag", () => {
		expect(parseWorkBuddyModel({ ...row, disabledMultimodal: true })?.supportsImages).toBe(false);
	});

	it("falls back to the id for a missing name and omits unknown optionals", () => {
		const parsed = parseWorkBuddyModel({ id: "x", maxInputTokens: 10, maxOutputTokens: 10 });
		expect(parsed).toEqual({ id: "x", name: "x", contextWindow: 10, maxTokens: 10 });
	});
});

describe("selectWorkBuddyRoster", () => {
	const models = [
		{ id: "a", maxInputTokens: 10, maxOutputTokens: 10 },
		{ id: "b", maxInputTokens: 10, maxOutputTokens: 10 },
		{ id: "c", maxInputTokens: 10, maxOutputTokens: 10 },
	];

	it("prefers the cli agent's own roster, which is what the chat path emulates", () => {
		const roster = selectWorkBuddyRoster({
			models,
			agents: [{ description: "cli agent", models: ["b"] }, { description: "other" }],
		});
		expect(roster.map((model) => model.id)).toEqual(["b"]);
	});

	it("falls back to the whole list when no cli agent is present", () => {
		expect(selectWorkBuddyRoster({ models }).map((model) => model.id)).toEqual(["a", "b", "c"]);
		expect(selectWorkBuddyRoster({ models, agents: [{ description: "cli agent", models: ["zzz"] }] }).length).toBe(3);
	});

	it("returns nothing for a non-catalog body", () => {
		expect(selectWorkBuddyRoster(undefined)).toEqual([]);
		expect(selectWorkBuddyRoster({})).toEqual([]);
	});
});

describe("fetchWorkBuddyCatalog", () => {
	it("reads /v3/config and asks as the CLI channel", async () => {
		const seen: Array<{ url: string; headers: Headers }> = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			seen.push({ url, headers: new Headers(init?.headers) });
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "a", maxInputTokens: 10, maxOutputTokens: 5 }] },
			});
		});
		try {
			const roster = await fetchWorkBuddyCatalog(credential());
			expect(roster.map((model) => model.id)).toEqual(["a"]);
			expect(seen[0]?.url).toBe("https://copilot.tencent.com/v3/config");
			// The UA is load-bearing: /v3 serves a different roster per channel.
			expect(seen[0]?.headers.get("user-agent")).toBe("CLI/2.63.2 CodeBuddy/2.63.2");
			expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-a");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("falls back to the legacy path and reports it", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			if (url.endsWith("/v3/config")) return jsonResponse({ code: 1, msg: "nope", data: null });
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { models: [{ id: "z", maxInputTokens: 10, maxOutputTokens: 5 }] },
			});
		});
		const onFallback = vi.fn();
		try {
			const roster = await fetchWorkBuddyCatalog(credential(), undefined, onFallback);
			expect(roster.map((model) => model.id)).toEqual(["z"]);
			expect(urls).toEqual([
				"https://copilot.tencent.com/v3/config",
				"https://copilot.tencent.com/v2/enterprises/personal/models",
			]);
			expect(onFallback).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fails when the roster is empty rather than serving nothing silently", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ code: 0, msg: "OK", data: { models: [] } }));
		try {
			await expect(fetchWorkBuddyCatalog(credential())).rejects.toThrow(/no usable models/iu);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("check-in", () => {
	it("parses today's status", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					active: true,
					today_checked_in: false,
					streak_days: 1,
					daily_credit: 100,
					today_credit: 100,
					is_streak_day: false,
					next_streak_day: 0,
					streak_bonus_days: 0,
					streak_bonus_credit: 0,
					claim_button_text: "Check in",
				},
			}),
		);
		try {
			expect(await fetchWorkBuddyCheckinStatus(credential())).toEqual({
				active: true,
				todayCheckedIn: false,
				streakDays: 1,
				dailyCredit: 100,
				todayCredit: 100,
				isStreakDay: false,
				nextStreakDay: 0,
				streakBonusDays: 0,
				streakBonusCredit: 0,
				claimButtonText: "Check in",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("POSTs the claim to the billing host with the thin header set", async () => {
		const seen: Array<{ url: string; method?: string | undefined; body?: unknown; headers: Headers }> = [];
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			seen.push({ url, method: init?.method, body: init?.body, headers: new Headers(init?.headers) });
			return jsonResponse({ code: 0, msg: "OK", data: { credit: 100, streak_days: 2, is_streak_day: true } });
		});
		try {
			expect(await claimWorkBuddyCheckin(credential())).toEqual({ credit: 100, streakDays: 2, isStreakDay: true });
			expect(seen[0]?.url).toBe("https://www.codebuddy.cn/v2/billing/meter/daily-checkin");
			expect(seen[0]?.method).toBe("POST");
			expect(seen[0]?.body).toBe("{}");
			expect(seen[0]?.headers.get("user-agent")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("credits", () => {
	it("reads the PER-ROW remaining amount, not the envelope aggregate", async () => {
		// Regression: the row fields are `CapacityRemain`/`CapacitySize`; `Dosage`
		// and `TotalDosage` exist only on the parent `Data` object, so reading them
		// per row reported every package as 0.
		//
		// Regression 2: a MONTHLY row keeps `CapacityRemain` at the full allocation
		// (500/500 here) and puts the real spend in the cycle counters. Reading the
		// package-level field made a used-up month read as untouched, so a summed
		// aggregate displayed the TOTAL credit instead of the REMAINING credit.
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					Response: {
						Data: {
							TotalCount: 2,
							// The envelope aggregate must NOT be mistaken for a row value.
							TotalDosage: 2200,
							Accounts: [
								{
									AccountId: 1,
									DealName: "monthly",
									PackageName: "CodeBuddy personal",
									CapacityType: 4,
									CapacityUnit: "credits",
									// Full allocation, deliberately untouched: the row's real
									// remaining is the cycle figure below.
									CapacityRemain: 500,
									CapacitySize: 500,
									CycleCapacityRemain: 258,
									CycleCapacitySize: 500,
									CycleStartTime: "2026-10-01 00:00:00",
									CycleEndTime: "2026-10-31 23:59:59",
								},
								{
									AccountId: 2,
									DealName: "gift",
									CapacityType: 1,
									CapacityUnit: "credits",
									CapacityRemain: 50,
									CapacitySize: 50,
								},
							],
						},
					},
				},
			}),
		);
		try {
			const credits = await fetchWorkBuddyCredits(credential());
			expect(credits.totalCount).toBe(2);
			// 258 (the monthly cycle's real remainder) + 50 (the gift's), NOT 550.
			expect(credits.totalRemaining).toBe(308);
			expect(credits.packages[0]).toEqual({
				accountId: 1,
				dealName: "monthly",
				packageName: "CodeBuddy personal",
				capacityType: 4,
				capacityUnit: "credits",
				remaining: 258,
				total: 500,
				monthly: true,
				cycleStartTime: "2026-10-01 00:00:00",
				cycleEndTime: "2026-10-31 23:59:59",
			});
			expect(credits.packages[1]).toEqual({
				accountId: 2,
				dealName: "gift",
				capacityType: 1,
				capacityUnit: "credits",
				remaining: 50,
				total: 50,
				monthly: false,
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("falls back to the package fields when a monthly row omits the cycle counters", async () => {
		// The cycle keys are preferred, not assumed: an upstream that stops sending
		// them must not make the package read as empty.
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					Response: {
						Data: {
							Accounts: [
								{
									AccountId: 1,
									DealName: "monthly-no-cycle",
									CapacityType: 4,
									CapacityRemain: 480,
									CapacitySize: 500,
								},
							],
						},
					},
				},
			}),
		);
		try {
			const credits = await fetchWorkBuddyCredits(credential());
			expect(credits.packages[0]).toMatchObject({ remaining: 480, total: 500, monthly: true });
			expect(credits.totalRemaining).toBe(480);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("clamps a negative remainder to zero rather than subtracting from the total", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({
				code: 0,
				msg: "OK",
				data: {
					Response: {
						Data: {
							Accounts: [
								{ AccountId: 1, DealName: "overdrawn", CapacityType: 1, CapacityRemain: -12, CapacitySize: 100 },
							],
						},
					},
				},
			}),
		);
		try {
			const credits = await fetchWorkBuddyCredits(credential());
			expect(credits.packages[0]).toMatchObject({ remaining: 0, total: 100 });
			expect(credits.totalRemaining).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("sends the hand-formatted date range, not an ISO string", async () => {
		let body = "";
		vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
			body = String(init?.body ?? "");
			return jsonResponse({ code: 0, msg: "OK", data: { Response: { Data: { Accounts: [] } } } });
		});
		try {
			await fetchWorkBuddyCredits(credential());
			const parsed = JSON.parse(body) as { ProductCode: string; PackageEndTimeRangeBegin: string; Status: number[] };
			expect(parsed.ProductCode).toBe("p_tcaca");
			expect(parsed.Status).toEqual([0, 3]);
			// The billing host wants `YYYY-MM-DD HH:mm:ss` in LOCAL time; an ISO
			// string with a `T` and a `Z` is a different request.
			expect(parsed.PackageEndTimeRangeBegin).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("survives a missing inner wrapper without inventing credits", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ code: 0, msg: "OK", data: {} }));
		try {
			expect(await fetchWorkBuddyCredits(credential())).toEqual({ totalCount: 0, totalRemaining: 0, packages: [] });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("parses a response LARGER than any error-excerpt bound", async () => {
		// Regression: the envelope reader used to slice the body to 4 KiB BEFORE
		// parsing, so a real credit list (measured at 5.8 KiB) failed as
		// "non-JSON". The excerpt bound must apply to error text only, never to
		// the payload that is actually parsed.
		const many = Array.from({ length: 200 }, (_unused, index) => ({
			AccountId: index,
			DealName: `deal-${index}-${"x".repeat(40)}`,
			CapacityType: 4,
			CapacityUnit: "credits",
			CapacityRemain: 10,
			CapacitySize: 10,
		}));
		const payload = { code: 0, msg: "OK", data: { Response: { Data: { TotalCount: many.length, Accounts: many } } } };
		const serialized = JSON.stringify(payload);
		expect(serialized.length).toBeGreaterThan(4096);
		vi.stubGlobal(
			"fetch",
			async () => new Response(serialized, { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		try {
			const credits = await fetchWorkBuddyCredits(credential());
			expect(credits.packages).toHaveLength(200);
			expect(credits.totalRemaining).toBe(2000);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("refuses an oversized answer by its declared length instead of parsing it", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(JSON.stringify({ code: 0, msg: "OK", data: {} }), {
					status: 200,
					headers: { "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) },
				}),
		);
		try {
			await expect(fetchWorkBuddyCredits(credential())).rejects.toThrow(/more than/u);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("refreshWorkBuddyToken", () => {
	it("merges the outcome and treats expiresIn as seconds", async () => {
		let url = "";
		vi.stubGlobal("fetch", async (target: string) => {
			url = target;
			return jsonResponse({
				code: 0,
				msg: "OK",
				data: { accessToken: "new", refreshToken: "new-refresh", expiresIn: 3600, domain: "www.workbuddy.cn" },
			});
		});
		try {
			expect(await refreshWorkBuddyToken(credential())).toEqual({
				accessToken: "new",
				refreshToken: "new-refresh",
				expiresInSec: 3600,
				domain: "www.workbuddy.cn",
			});
			expect(url).toBe("https://copilot.tencent.com/v2/plugin/auth/token/refresh");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fails loudly when the gateway returns no access token", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ code: 0, msg: "OK", data: {} }));
		try {
			await expect(refreshWorkBuddyToken(credential())).rejects.toThrow(/no accessToken/iu);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("classifyWorkBuddyError", () => {
	it("recognizes the bilingual credit markers", () => {
		// The lowercased comparison is what makes the English spellings match
		// regardless of the gateway's capitalization.
		for (const body of [
			"积分不足",
			"额度不足",
			"余额不足",
			"积分用完",
			"额度用尽",
			"没有积分",
			"insufficient credit",
			"Insufficient Credit",
			"quota exceeded",
			"payment required",
		]) {
			expect(classifyWorkBuddyError(200, body)).toBe("quota");
		}
	});

	it("does not invent a marker the gateway was never observed to send", () => {
		// `insufficient quota` (with a space) is NOT in the verified set, and a
		// fabricated variant would classify a benign message as an exhausted account.
		expect(classifyWorkBuddyError(200, "insufficient_quota")).toBe("transport");
		expect(classifyWorkBuddyError(200, "insufficient quota")).toBe("transport");
	});

	it("decides 402 before scanning the text", () => {
		expect(classifyWorkBuddyError(402, "")).toBe("quota");
		expect(classifyWorkBuddyError(402, "Offline user session not found")).toBe("quota");
	});

	it("recognizes a dead session", () => {
		expect(classifyWorkBuddyError(200, "Offline user session not found")).toBe("auth");
		expect(classifyWorkBuddyError(200, '{"code":12153}')).toBe("auth");
	});

	it("maps the remaining statuses coarsely", () => {
		expect(classifyWorkBuddyError(401, "")).toBe("auth");
		expect(classifyWorkBuddyError(402, "")).toBe("quota");
		expect(classifyWorkBuddyError(429, "")).toBe("rate_limit");
		expect(classifyWorkBuddyError(404, "")).toBe("not_found");
		expect(classifyWorkBuddyError(503, "")).toBe("server");
		expect(classifyWorkBuddyError(400, "")).toBe("client");
	});

	it("raises a typed error for a JSON body that is not an envelope", async () => {
		// A JSON array parses but carries no `{code,msg,data}` shape, so it must be
		// an error rather than a silently-empty success.
		vi.stubGlobal("fetch", async () => jsonResponse([], 200));
		try {
			const failure = await fetchWorkBuddyCheckinStatus(credential()).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(WorkBuddyUpstreamError);
			expect((failure as WorkBuddyUpstreamError).kind).toBe("server");
			expect((failure as Error).message).toContain("unexpected envelope");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("turns a business-code failure into a classified error", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ code: 11140, msg: "额度不足", data: null }));
		try {
			const failure = await fetchWorkBuddyCheckinStatus(credential()).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(WorkBuddyUpstreamError);
			expect((failure as WorkBuddyUpstreamError).kind).toBe("quota");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("maps a non-JSON answer to a classified error instead of a parse crash", async () => {
		vi.stubGlobal("fetch", async () => new Response("<html>openresty 401</html>", { status: 401 }));
		try {
			await expect(fetchWorkBuddyCheckinStatus(credential())).rejects.toBeInstanceOf(WorkBuddyUpstreamError);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("prepareWorkBuddyChatBody", () => {
	const parse = (source: string): Record<string, unknown> =>
		JSON.parse(prepareWorkBuddyChatBody(source)) as Record<string, unknown>;

	it("forces streaming even when the caller asked for none", () => {
		expect(parse(JSON.stringify({ stream: false, messages: [] })).stream).toBe(true);
	});

	it("rewrites developer to system, which the gateway rejects otherwise", () => {
		const body = parse(JSON.stringify({ messages: [{ role: "developer", content: "hi" }] }));
		expect((body.messages as Array<{ role: string }>)[0]?.role).toBe("system");
	});

	it("prepends the fallback system message to a user-first conversation", () => {
		const body = parse(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
		expect((body.messages as unknown[])[0]).toEqual({
			role: "system",
			content: WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
		});
	});

	it("leaves an existing system head untouched", () => {
		const body = parse(
			JSON.stringify({
				messages: [
					{ role: "system", content: "real" },
					{ role: "user", content: "hi" },
				],
			}),
		);
		expect((body.messages as Array<{ content: string }>)[0]?.content).toBe("real");
	});

	it("flattens an object tool_choice to the bare string the gateway accepts", () => {
		expect(parse(JSON.stringify({ messages: [], tool_choice: { type: "auto" } })).tool_choice).toBe("auto");
		expect(parse(JSON.stringify({ messages: [], tool_choice: { type: "required" } })).tool_choice).toBe("required");
		expect(
			parse(JSON.stringify({ messages: [], tool_choice: { type: "function", function: { name: "read" } } }))
				.tool_choice,
		).toBe("read");
	});

	it("removes the tool declarations when the choice is none", () => {
		const body = parse(
			JSON.stringify({
				messages: [],
				tool_choice: "none",
				tools: [{ type: "function" }],
				functions: [{ name: "read" }],
			}),
		);
		expect(body.tool_choice).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(body.functions).toBeUndefined();
	});

	it("passes the model id through verbatim", () => {
		expect(parse(JSON.stringify({ messages: [], model: "glm-5.3" })).model).toBe("glm-5.3");
		expect(parse(JSON.stringify({ messages: [], model: "auto" })).model).toBe("auto");
	});

	it("returns unparseable input unchanged rather than corrupting it", () => {
		expect(prepareWorkBuddyChatBody("not json")).toBe("not json");
		expect(prepareWorkBuddyChatBody("[]")).toBe("[]");
	});
});
