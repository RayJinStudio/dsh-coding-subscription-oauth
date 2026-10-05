/**
 * Kimi Code subscription search provider: payload mapping, request contract,
 * auth/error mapping, and the redirect-rejection policy for the credentialed call.
 */
import { describe, expect, it, vi } from "vitest";
import {
	createKimiSearchProvider,
	KIMI_SEARCH_PROVIDER_ID,
	KIMI_SEARCH_URL,
	mapKimiSearchResponse,
} from "../src/kimi-search.ts";
import type { KimiAuthSession } from "../src/kimi-usage.ts";

function auth(token: string | undefined = "token-a"): KimiAuthSession & { invalidated: number } {
	const session = {
		invalidated: 0,
		resolve: async () => (token === undefined ? undefined : { accessToken: token }),
		invalidate: async () => {
			session.invalidated += 1;
		},
	};
	return session;
}

/** A disconnected subscription: `resolve()` yields no token. */
function disconnectedAuth(): KimiAuthSession {
	return { resolve: async () => undefined, invalidate: async () => undefined };
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const OK_PAYLOAD = {
	search_results: [
		{ title: "Kimi Code docs", url: "https://www.kimi.com/code/docs/", snippet: "Kimi Code documentation" },
		{ url: "https://example.com/b", site_name: "Example", content: "fallback snippet", date: "2026-02-01" },
	],
};

describe("mapKimiSearchResponse", () => {
	it("normalizes the official payload and keeps citeable sources", () => {
		expect(mapKimiSearchResponse(OK_PAYLOAD)).toEqual({
			sources: [
				{ url: "https://www.kimi.com/code/docs/", title: "Kimi Code docs", snippet: "Kimi Code documentation" },
				{
					url: "https://example.com/b",
					title: "Example",
					snippet: "fallback snippet",
					publishedAt: "2026-02-01",
				},
			],
			truncated: false,
		});
	});

	it("falls back to the hostname for a missing title and drops non-http(s) URLs", () => {
		const mapped = mapKimiSearchResponse({
			search_results: [
				{ url: "https://example.com/no-title" },
				{ url: "ftp://example.com/file" },
				{ url: "https://user:pass@example.com/secret" },
				{ url: "not a url" },
				{ title: "no url at all" },
			],
		});
		expect(mapped.sources).toEqual([{ url: "https://example.com/no-title", title: "example.com" }]);
	});

	it("de-duplicates by url and truncates to maxResults", () => {
		const mapped = mapKimiSearchResponse(
			{
				search_results: [
					{ url: "https://example.com/a" },
					{ url: "https://example.com/a", title: "dup" },
					{ url: "https://example.com/b" },
				],
			},
			1,
		);
		expect(mapped.sources).toEqual([{ url: "https://example.com/a", title: "example.com" }]);
		expect(mapped.truncated).toBe(true);
	});

	it("rejects malformed payloads and invalid maxResults", () => {
		expect(() => mapKimiSearchResponse(null)).toThrow(/malformed/u);
		expect(() => mapKimiSearchResponse({ results: [] })).toThrow(/malformed/u);
		expect(() => mapKimiSearchResponse(OK_PAYLOAD, 0)).toThrow(/at least 1/u);
		expect(() => mapKimiSearchResponse(OK_PAYLOAD, Number.NaN)).toThrow(/at least 1/u);
	});
});

describe("createKimiSearchProvider", () => {
	it("posts only text_query with host-side bearer auth and no model field", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
		const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: fetchImpl as unknown as typeof fetch });
		expect(provider.id).toBe(KIMI_SEARCH_PROVIDER_ID);

		const result = await provider.search({ query: "  kimi code  " });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(KIMI_SEARCH_URL);
		expect(init.method).toBe("POST");
		// The search endpoint carries no model; sending one is not part of its contract.
		expect(JSON.parse(String(init.body))).toEqual({ text_query: "kimi code" });
		expect(init.redirect).toBe("error");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-a");
		expect(result.sources).toHaveLength(2);
	});

	it("honors maxResults at the request layer", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
		const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: fetchImpl as unknown as typeof fetch });
		const result = await provider.search({ query: "kimi", maxResults: 1 });
		expect(result.sources).toHaveLength(1);
		expect(result.truncated).toBe(true);
	});

	it("fails without a connected subscription and never calls the endpoint", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
		const provider = createKimiSearchProvider({
			auth: disconnectedAuth(),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await expect(provider.search({ query: "dsh" })).rejects.toMatchObject({ code: "INVALID_ARGS" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects an empty query before spending a request", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
		const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(provider.search({ query: "   " })).rejects.toMatchObject({ code: "INVALID_ARGS" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("invalidates the cached token on 401 and reports AUTH", async () => {
		const session = auth();
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
		const provider = createKimiSearchProvider({ auth: session, fetchImpl: fetchImpl as unknown as typeof fetch });
		await expect(provider.search({ query: "dsh" })).rejects.toMatchObject({ code: "AUTH" });
		expect(session.invalidated).toBe(1);
	});

	it("maps quota, server, and transport failures onto stable codes", async () => {
		const cases: readonly [number, string][] = [
			[402, "QUOTA"],
			[500, "SERVER"],
			[429, "SERVER"],
		];
		for (const [status, code] of cases) {
			const fetchImpl = vi.fn(async () => jsonResponse({}, status));
			const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: fetchImpl as unknown as typeof fetch });
			await expect(provider.search({ query: "dsh" })).rejects.toMatchObject({ code });
		}

		const broken = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: broken as unknown as typeof fetch });
		await expect(provider.search({ query: "dsh" })).rejects.toMatchObject({ code: "TRANSPORT" });
	});

	it("reports an unreadable or malformed body instead of throwing raw", async () => {
		const unreadable = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
		const provider = createKimiSearchProvider({
			auth: auth(),
			fetchImpl: unreadable as unknown as typeof fetch,
		});
		await expect(provider.search({ query: "dsh" })).rejects.toMatchObject({ code: "SERVER" });

		const malformed = vi.fn(async () => jsonResponse({ results: [] }));
		const provider2 = createKimiSearchProvider({
			auth: auth(),
			fetchImpl: malformed as unknown as typeof fetch,
		});
		await expect(provider2.search({ query: "dsh" })).rejects.toMatchObject({ code: "SERVER" });
	});

	it("reports cancellation as TIMEOUT and forwards a caller abort", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		});
		const provider = createKimiSearchProvider({ auth: auth(), fetchImpl: fetchImpl as unknown as typeof fetch });
		controller.abort();
		await expect(provider.search({ query: "dsh" }, controller.signal)).rejects.toMatchObject({ code: "TIMEOUT" });
	});
});
