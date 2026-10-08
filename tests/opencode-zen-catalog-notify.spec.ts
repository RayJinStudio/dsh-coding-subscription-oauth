/**
 * Regression: a Zen selection change must ANNOUNCE itself.
 *
 * Every other provider in this plugin refreshes DSH's model list immediately
 * because its catalog change emits `llm/adapters-updated`, which is the event
 * DSH listens on to re-read `listModels`. The Zen route initially only refreshed
 * its own cached snapshot, so a newly enabled or disabled model stayed invisible
 * in the picker until the plugin reloaded — the bug this suite pins.
 *
 * Driven through the REAL plugin wiring with a real Cordis `Context`, because
 * the announcement happens on the owner context that the settings route is
 * registered from. A unit test of the controller alone cannot see it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Context, Service } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { apply, inject, name } from "../src/index.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { OPENCODE_ZEN_CONNECTION_PATH } from "../src/opencode-zen-connection.ts";
import { GrokBuildSession } from "../src/session.ts";
import { WorkBuddySession } from "../src/workbuddy-session.ts";

type Handler = (req: unknown, res: unknown) => void | Promise<void>;

/** Minimal in-memory web route table, mirroring the host service contract. */
class TestWebServer extends Service {
	readonly routes = new Map<string, Handler>();
	constructor(ctx: Context) {
		super(ctx, "webServer");
	}
	register(route: { path: string; handler: Handler }): () => void {
		if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
		this.routes.set(route.path, route.handler);
		return () => this.routes.delete(route.path);
	}
}

/** Minimal credential service: writable store, nothing configured initially. */
class TestCredentials extends Service {
	private readonly values = new Map<string, string>();
	constructor(ctx: Context) {
		super(ctx, "credentials");
	}
	async describe(ref: string) {
		return { configured: this.values.has(String(ref)), writable: true, source: null };
	}
	async resolve(ref: string) {
		const value = this.values.get(String(ref));
		return value === undefined ? undefined : { value };
	}
	async set(ref: string, value: string) {
		this.values.set(String(ref), value);
	}
	async unset(ref: string) {
		this.values.delete(String(ref));
	}
}

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "dsh-zen-notify-"));
	process.env["DSH_HOME"] = home;
	// These startup chains do real network I/O; stubbed so the test is about the
	// announcement rather than network timing (startup.spec.ts stubs them too).
	vi.spyOn(WorkBuddySession.prototype, "loadCachedState").mockResolvedValue(undefined);
	vi.spyOn(WorkBuddySession.prototype, "refreshCatalog").mockResolvedValue(undefined);
	vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
	vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
	vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
});
afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env["DSH_HOME"];
	await rm(home, { recursive: true, force: true });
});

function recorder() {
	const state = { status: 0, body: "" };
	return {
		state,
		res: {
			writeHead(status: number) {
				state.status = status;
				return this;
			},
			end(body?: string) {
				state.body = body ?? "";
			},
		},
	};
}

function postBody(payload: unknown) {
	// `readJsonRequest` consumes a real readable stream, so the fake request is
	// backed by one rather than by an iterator shim.
	const stream = Readable.from([Buffer.from(JSON.stringify(payload))]);
	return Object.assign(stream, {
		method: "POST",
		url: OPENCODE_ZEN_CONNECTION_PATH,
		// The owner-request policy requires a loopback TCP peer plus a loopback
		// Host/origin pair, so the fake request carries both.
		socket: { remoteAddress: "127.0.0.1" },
		headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "content-type": "application/json" },
	});
}

it("announces a Zen model-selection change so DSH re-reads the model list", async () => {
	const root = new Context();
	const fiber = root.plugin({ name, inject, apply });
	await Promise.resolve();

	let webServer: TestWebServer | undefined;
	const webFiber = root.plugin((ctx) => {
		webServer = new TestWebServer(ctx);
	});
	const credentialsFiber = root.plugin((ctx) => {
		new TestCredentials(ctx);
	});
	await credentialsFiber;
	await webFiber;
	await fiber;

	const handler = webServer?.routes.get(OPENCODE_ZEN_CONNECTION_PATH);
	expect(handler, `${OPENCODE_ZEN_CONNECTION_PATH} must be registered`).toBeTypeOf("function");

	// Listen on the real event bus rather than spying on `emit`, so this observes
	// exactly what a DSH listener would receive.
	const emitted: string[] = [];
	root.on(
		"llm/adapters-updated" as never,
		(() => {
			emitted.push("llm/adapters-updated");
		}) as never,
	);

	const { res, state } = recorder();
	await handler!(postBody({ action: "apply", models: ["mimo-v2.6-flash-free"] }), res);

	// The action succeeded...
	expect(state.status, state.body).toBe(200);
	// ...and DSH was told to re-read the catalog. Without this the new selection
	// stays invisible in the model picker until the plugin reloads.
	expect(emitted).toContain("llm/adapters-updated");

	await fiber.dispose();
	await webFiber.dispose();
	await credentialsFiber.dispose();
});
