/** @vitest-environment jsdom */
/**
 * Regression coverage for the composer subscription-usage badge: the data
 * pipeline the migrated feature depends on (`/oauth/usage` aggregate, its
 * per-provider fallbacks, and the window projection the pill renders) must
 * turn real server payloads into a visible pill, and the pill must follow the
 * selected model's provider rather than any provider that happens to have data.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	SUBSCRIPTION_USAGE_PATH,
	CODEX_USAGE_PATH,
	KIMI_USAGE_PATH,
} from "../src/client/constants.ts";
import { SubscriptionUsageBadge, providerKeyOf } from "../src/client/SubscriptionUsageBadge.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.localStorage.clear();
});

/** One fixed selection, as the badge's `currentModel` seat would report. */
function selectsModel(provider: string, model: string) {
	return async () => ({ provider, model });
}

/** Exact projection the plugin's `/plugins/dsh-grok-build/kimi/usage` route served. */
const kimiPayload = {
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
};

/** Shipped `CodexUsage` projection (camelCase, epoch-second resets). */
const codexPayload = {
	rateLimits: [
		{
			id: "codex",
			name: "Codex",
			windows: [
				{ usedPercent: 25, remainingPercent: 75, windowSeconds: 18_000, resetsAt: 1_791_113_203 },
				{ usedPercent: 40, remainingPercent: 60, windowSeconds: 604_800, resetsAt: 1_791_713_203 },
			],
		},
	],
	fetchedAt: 1_791_113_203_417,
};

function stubFetch(routes: Record<string, unknown>): string[] {
	const requested: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			requested.push(url);
			if (!(url in routes)) return new Response("{}", { status: 500 });
			return new Response(JSON.stringify(routes[url]), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return requested;
}

it("renders the pill for usage returned by the plugin's own HTTP routes", async () => {
	stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: true, usage: codexPayload }, kimi: { supported: false } },
		},
	});
	render(createElement(SubscriptionUsageBadge, { currentModel: selectsModel("codex-oauth", "gpt-5-codex") }));
	const pill = await screen.findByRole("button", { name: /Subscription usage · Codex/u });
	expect(pill.textContent).toContain("Codex");
	expect(pill.textContent).toContain("25%");
});

it("renders the Kimi pill from the aggregate route without the codex fallback", async () => {
	const requested = stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: false }, kimi: { supported: true, usage: kimiPayload } },
		},
	});
	render(createElement(SubscriptionUsageBadge, { currentModel: selectsModel("kimi-code-oauth", "kimi-k2") }));
	const pill = await screen.findByRole("button", { name: /Subscription usage · Kimi/u });
	expect(pill.textContent).toContain("Kimi");
	expect(pill.textContent).toContain("4%");
	expect(requested).toEqual([SUBSCRIPTION_USAGE_PATH]);
	expect(requested).not.toContain(CODEX_USAGE_PATH);
});

it("falls back to the per-provider routes when the aggregate omits a provider", async () => {
	const requested = stubFetch({
		// Older plugin builds answered `/oauth/usage` without per-provider shares.
		[SUBSCRIPTION_USAGE_PATH]: {},
		[CODEX_USAGE_PATH]: codexPayload,
		[KIMI_USAGE_PATH]: kimiPayload,
	});
	render(createElement(SubscriptionUsageBadge, { currentModel: selectsModel("codex-oauth", "gpt-5-codex") }));
	await screen.findByRole("button", { name: /Subscription usage/u });
	await waitFor(() => expect(requested).toContain(CODEX_USAGE_PATH));
	expect(requested).toContain(KIMI_USAGE_PATH);
});

it("treats the aggregate's own answer as authoritative for a provider", async () => {
	const requested = stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: false }, kimi: { supported: true, usage: kimiPayload } },
		},
		[CODEX_USAGE_PATH]: codexPayload,
		[KIMI_USAGE_PATH]: kimiPayload,
	});
	render(createElement(SubscriptionUsageBadge, { currentModel: selectsModel("kimi-code-oauth", "kimi-k2") }));
	const pill = await screen.findByRole("button", { name: /Subscription usage · Kimi/u });
	expect(pill.textContent).toContain("Kimi");
	expect(requested).not.toContain(CODEX_USAGE_PATH);
	expect(requested).not.toContain(KIMI_USAGE_PATH);
});

it("renders nothing when no provider reports usage", async () => {
	stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: { providers: { codex: { supported: false }, kimi: { supported: false } } },
		[CODEX_USAGE_PATH]: { error: "not connected" },
		[KIMI_USAGE_PATH]: { error: "not connected" },
	});
	const view = render(
		createElement(SubscriptionUsageBadge, { currentModel: selectsModel("codex-oauth", "gpt-5-codex") }),
	);
	await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
	expect(view.container.querySelector("span")).not.toBeNull();
});

it("renders nothing while the selected model is outside every supported subscription", async () => {
	stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: true, usage: codexPayload }, kimi: { supported: true, usage: kimiPayload } },
		},
	});
	const view = render(
		createElement(SubscriptionUsageBadge, { currentModel: selectsModel("deepseek-account", "deepseek-v4") }),
	);
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(screen.queryByRole("button")).toBeNull();
	expect(view.container.querySelector("span")).not.toBeNull();
});

it("renders nothing before the selected model is known", async () => {
	stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: true, usage: codexPayload }, kimi: { supported: true, usage: kimiPayload } },
		},
	});
	render(createElement(SubscriptionUsageBadge, {}));
	await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});

it("follows the selected model when both subscriptions report usage", async () => {
	stubFetch({
		[SUBSCRIPTION_USAGE_PATH]: {
			providers: { codex: { supported: true, usage: codexPayload }, kimi: { supported: true, usage: kimiPayload } },
		},
	});
	const view = render(
		createElement(SubscriptionUsageBadge, { currentModel: selectsModel("kimi-code-oauth", "kimi-k2") }),
	);
	const kimiPill = await screen.findByRole("button", { name: /Subscription usage · Kimi/u });
	expect(kimiPill.textContent).not.toContain("Codex");

	view.rerender(
		createElement(SubscriptionUsageBadge, { currentModel: selectsModel("codex-oauth", "gpt-5-codex") }),
	);
	const codexPill = await screen.findByRole("button", { name: /Subscription usage · Codex/u });
	expect(codexPill.textContent).not.toContain("Kimi");
});

it("maps every supported route id onto its provider key", () => {
	expect(providerKeyOf("codex-oauth")).toBe("codex");
	expect(providerKeyOf("openai-codex")).toBe("codex");
	expect(providerKeyOf("kimi-code-oauth")).toBe("kimi");
	expect(providerKeyOf("kimi-coding")).toBe("kimi");
	expect(providerKeyOf("grok-build")).toBeUndefined();
	expect(providerKeyOf("deepseek-account")).toBeUndefined();
	expect(providerKeyOf(undefined)).toBeUndefined();
});
