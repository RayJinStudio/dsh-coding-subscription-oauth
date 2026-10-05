/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchTab } from "../src/client/components/SearchTab.tsx";
import { en } from "../src/client/locales.ts";
import { parseSearchProvider } from "../src/client/parsers.ts";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const t = (key: keyof typeof en) => en[key];

function stubFetch(payload: unknown, ok = true, status = 200): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(payload), { status: ok ? status : status, headers: { "content-type": "application/json" } })),
	);
}

describe("parseSearchProvider", () => {
	it("admits the server projection", () => {
		expect(
			parseSearchProvider({
				writable: true,
				current: "kimi-oauth-search",
				candidates: [
					{ id: "deepseek-official", builtIn: true, available: true },
					{ id: "kimi-oauth-search", builtIn: false, available: false },
				],
			}),
		).toEqual({
			writable: true,
			current: "kimi-oauth-search",
			candidates: [
				{ id: "deepseek-official", builtIn: true, available: true },
				{ id: "kimi-oauth-search", builtIn: false, available: false },
			],
		});
	});

	it("degrades an unreadable payload to read-only with no candidates", () => {
		expect(parseSearchProvider(null)).toEqual({ writable: false, current: "", candidates: [] });
		expect(parseSearchProvider({ candidates: [{ builtIn: true }] })).toEqual({
			writable: false,
			current: "",
			candidates: [],
		});
	});
});

describe("SearchTab", () => {
	it("lists the auto option plus every candidate, marking origin and usability", async () => {
		stubFetch({
			writable: true,
			current: "deepseek-official",
			candidates: [
				{ id: "deepseek-official", builtIn: true, available: true },
				{ id: "kimi-oauth-search", builtIn: false, available: false },
			],
		});
		render(createElement(SearchTab, { t }));

		await screen.findByLabelText(en.searchProviderField);
		expect(screen.getByRole("option", { name: en.searchProviderAuto })).toBeTruthy();
		expect(screen.getByRole("option", { name: `deepseek-official · ${en.searchProviderBuiltIn}` })).toBeTruthy();
		const unavailable = screen.getByRole("option", {
			name: `kimi-oauth-search · ${en.searchProviderUnavailableTag}`,
		}) as HTMLOptionElement;
		expect(unavailable.disabled).toBe(true);
	});

	it("patches the selected provider", async () => {
		const calls: { url: string; method: string; body: unknown }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({
					url,
					method: init?.method ?? "GET",
					body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
				});
				return new Response(
					JSON.stringify(
						(init?.method ?? "GET") === "GET"
							? { writable: true, current: "deepseek-official", candidates: [{ id: "kimi-oauth-search", builtIn: false, available: true }] }
							: { writable: true, current: "kimi-oauth-search", candidates: [{ id: "kimi-oauth-search", builtIn: false, available: true }] },
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		render(createElement(SearchTab, { t }));
		const select = (await screen.findByLabelText(en.searchProviderField)) as HTMLSelectElement;

		select.value = "kimi-oauth-search";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
		expect(calls.at(-1)?.body).toEqual({ searchProvider: "kimi-oauth-search" });
	});

	it("disables the control and explains itself when the profile is read-only", async () => {
		stubFetch({
			writable: false,
			current: "",
			candidates: [{ id: "deepseek-official", builtIn: true, available: true }],
			unavailableReason: "no editor",
		});
		render(createElement(SearchTab, { t }));
		const select = (await screen.findByLabelText(en.searchProviderField)) as HTMLSelectElement;
		expect(select.disabled).toBe(true);
		expect(screen.getByText("no editor")).toBeTruthy();
	});

	it("surfaces a read failure with a retry action", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })),
		);
		render(createElement(SearchTab, { t }));
		await screen.findByRole("alert");
		expect(screen.getByRole("button", { name: en.retry })).toBeTruthy();
	});

	it("also hosts the status-bar usage display setting", async () => {
		stubFetch({ writable: true, current: "", candidates: [] });
		render(createElement(SearchTab, { t }));
		// The badge preference moved off the accounts tab onto this page.
		expect(await screen.findByLabelText(en.usageBadgeDisplay)).toBeTruthy();
	});
});
