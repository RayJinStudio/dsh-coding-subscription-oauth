import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CLAUDE_CODE_OAUTH_ROUTE,
	CODEX_OAUTH_ROUTE,
	CODING_OAUTH_ALL_ROUTES,
	GROK_BUILD_ROUTE,
	KIMI_CODE_OAUTH_ROUTE,
	WORKBUDDY_ROUTE,
} from "../src/ids.ts";
import { WORKBUDDY_PI_PROVIDER } from "../src/workbuddy-provider.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bundle composition", () => {
	it("inserts the grok-build host plugin and a Grok Build default model", async () => {
		const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
		expect(patch).toContain("provider: grok-build");
		expect(patch).toMatch(/model: grok-4\./);
		expect(patch).toContain("id: llm-grok-build-oauth");
		expect(patch).toContain("name: dsh-coding-subscription-oauth");
	});

	it("exposes collision-free OAuth route aliases", async () => {
		expect([GROK_BUILD_ROUTE, CODEX_OAUTH_ROUTE, KIMI_CODE_OAUTH_ROUTE, CLAUDE_CODE_OAUTH_ROUTE]).toEqual([
			"grok-build",
			"codex-oauth",
			"kimi-code-oauth",
			"claude-code-oauth",
		]);
		// The WorkBuddy route must NOT be the reference plugin's id. That plugin
		// owns `workbuddy` and `workbuddy-global`, and `registerAdapter` is
		// all-or-nothing, so sharing the id makes the two plugins mutually
		// exclusive: one of them loses every route it owns and silently serves the
		// other's catalog and wire path.
		expect(WORKBUDDY_ROUTE).toBe("workbuddy-oauth");
		expect([...CODING_OAUTH_ALL_ROUTES]).not.toContain("workbuddy");
		expect([...CODING_OAUTH_ALL_ROUTES]).not.toContain("workbuddy-global");
		expect([...CODING_OAUTH_ALL_ROUTES]).toContain(WORKBUDDY_ROUTE);
		// pi-ai stamps `model.provider` with the provider id while the harness keys
		// its profile map by the route, so the two must be one string.
		expect(WORKBUDDY_PI_PROVIDER).toBe(WORKBUDDY_ROUTE);
		const source = await readFile(join(root, "src/index.ts"), "utf8");
		// WorkBuddy is registered on the same adapter as the OAuth routes, so the
		// list handed to `registerAdapter` must be the full one — the frozen core
		// tuple plus WorkBuddy — or the WorkBuddy route never becomes reachable.
		expect(source).toContain("[...CODING_OAUTH_ALL_ROUTES]");
		expect(source).toContain("registerCodingOAuthRoutes");
	});

	it("registers its adapter tolerantly so a route conflict cannot disable the plugin", async () => {
		// `ctx.llm.registerAdapter` is all-or-nothing: one route already owned by
		// another plugin (the reference `dsh-connect-workbuddy` also registers
		// `workbuddy`) throws DUPLICATE_ADAPTER and would withdraw this plugin's
		// unrelated routes too, leaving every provider here broken while its own
		// routes 404. Registration must therefore degrade to the routes it can hold.
		const source = await readFile(join(root, "src/index.ts"), "utf8");
		expect(source).toContain("registerOwnedRoutes(ctx, [...CODING_OAUTH_ALL_ROUTES]");
		expect(source).toContain("DUPLICATE_ADAPTER");
		expect(source).not.toContain("const adapterRegistration = ctx.llm.registerAdapter(");
		// The Codex Fast reconciler replaces the whole route list, so it must bind to
		// what was actually registered rather than the requested list.
		expect(source).toContain("baseRoutes: registeredRoutes");
	});

	it("ships a v0.4 host bundle that matches the capability client", async () => {
		const server = await readFile(join(root, "lib/index.js"), "utf8");
		for (const marker of [
			"/plugins/dsh-grok-build/oauth/sources",
			"/plugins/dsh-grok-build/capabilities",
			"codex-oauth-fast",
			"XAI_API_KEY",
			"/plugins/dsh-grok-build/imagine/media/",
		]) {
			expect(server).toContain(marker);
		}
		const imports = server.match(/^import .*$/gm) ?? [];
		expect(imports.some((statement) => statement.includes('"@deepseek-ai/dsh-tools"'))).toBe(false);
	});

	it("ships the pinned Antigravity authentication-discovery patch", async () => {
		const patch = await readFile(join(root, "patches/dsh-agy@0.1.2.patch"), "utf8");
		expect(patch).toContain('+\t\t\tname: "Google Antigravity (OAuth)"');
		expect(patch).toContain("+\t\t\tif (!session) return [];");
		expect(patch).toContain("+\t\t} catch {");
	});

	it("declares a dsh bundle and web client half", async () => {
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
			name: string;
			dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } };
			exports: Record<string, unknown>;
			files: string[];
		};
		expect(manifest.name).toBe("dsh-coding-subscription-oauth");
		expect((manifest as { version?: string }).version).toBe("0.8.5");
		expect((manifest as { dependencies?: Record<string, string> }).dependencies?.["dsh-coding-oauth-core"]).toBe(
			"0.1.2",
		);
		expect((manifest as { dependencies?: Record<string, string> }).dependencies?.undici).toBe("7.29.0");
		expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
		expect(manifest.dsh.client.platform).toBe("web");
		expect(manifest.dsh.client.inject).toContain("@deepseek-ai/dsh-client-ui-settings");
		expect(manifest.exports["./client"]).toBe("./lib/client.js");
		expect(manifest.files).toContain("scripts/verify-deployed-catalog.mjs");
		expect(manifest.files).toContain("scripts/smoke-deployed-routes.mjs");
		expect(manifest.files).toContain("patches/dsh-agy@0.1.2.patch");
	});
});
