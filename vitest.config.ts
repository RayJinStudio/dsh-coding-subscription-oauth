import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The DSH web shell injects this platform module at runtime; jsdom
			// tests resolve it to a minimal local stub (see tests/stubs).
			"@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(
				new URL("./tests/stubs/dsh-client-ui-primitives/index.js", import.meta.url),
			),
		},
	},
	test: {
		testTimeout: 15_000,
		include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["src/web-origin.ts", "src/gateway-routes.ts"],
			// Advisory floors for security-critical modules (aggregate over include).
			// Measured green baseline ~78% statements / ~76% branches / ~78% lines.
			thresholds: {
				statements: 70,
				branches: 70,
				functions: 90,
				lines: 70,
			},
		},
	},
});
