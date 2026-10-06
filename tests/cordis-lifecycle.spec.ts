import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { apply, inject, name } from "../src/index.ts";

/**
 * Every exact route the standalone plugin registers.
 *
 * Pinned as a number so an accidental route addition or removal is loud: the
 * routes are an operator-visible surface, and this assertion is the only place
 * that notices a silent change to it. Third-party optional routes (Codex Fast)
 * are published by REPLACING the adapter route list, not the web routes, so
 * they do not move this count.
 */
const EXPECTED_ROUTE_COUNT = 31;

class TestWebServer extends Service {
	readonly paths = new Set<string>();
	constructor(ctx: Context) {
		super(ctx, "webServer");
	}
	register(route: { path: string }): () => void {
		if (this.paths.has(route.path)) throw new Error(`duplicate route ${route.path}`);
		this.paths.add(route.path);
		return () => this.paths.delete(route.path);
	}
}

describe("Cordis webServer lifecycle", () => {
	it("waits for the real Service, registers once, and releases routes on root disposal", async () => {
		const root = new Context();
		expect(inject).toEqual(["webServer"]);
		const fiber = root.plugin({ name, inject, apply });
		await Promise.resolve();
		expect(root.registry.get(apply)?.fibers.length).toBe(1);
		let webServer: TestWebServer | undefined;
		const serviceFiber = root.plugin((ctx) => {
			webServer = new TestWebServer(ctx);
		});
		await serviceFiber;
		await fiber;
		expect(webServer?.paths.size).toBeGreaterThan(0);
		const initialPaths = [...webServer!.paths].sort();
		expect(initialPaths).toHaveLength(EXPECTED_ROUTE_COUNT);
		expect(initialPaths).toContain("/plugins/dsh-grok-build/workbuddy/status");
		expect(initialPaths).toContain("/plugins/dsh-grok-build/workbuddy/checkin");
		expect(initialPaths).toContain("/plugins/dsh-grok-build/workbuddy/models");
		await serviceFiber.dispose();
		expect(webServer!.paths.size).toBe(0);
		let replacement: TestWebServer | undefined;
		const replacementFiber = root.plugin((ctx) => {
			replacement = new TestWebServer(ctx);
		});
		await replacementFiber;
		await fiber;
		expect([...replacement!.paths].sort()).toEqual(initialPaths);
		expect(replacement!.paths).toHaveLength(EXPECTED_ROUTE_COUNT);
		expect(root.registry.get(apply)?.fibers.length).toBe(1);
		await replacementFiber.dispose();
		expect(replacement?.paths.size).toBe(0);
		await fiber.dispose();
		expect(root.registry.get(apply)).toBeUndefined();
	});
});
