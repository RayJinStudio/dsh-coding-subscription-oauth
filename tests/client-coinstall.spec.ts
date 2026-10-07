import { describe, expect, it, vi } from "vitest";
import { WORKBUDDY_ROUTE as CLIENT_WORKBUDDY_ROUTE } from "../src/client/constants.ts";
import { openHubAccountsSettings } from "../src/client/display.ts";
import { WORKBUDDY_ROUTE as SERVER_WORKBUDDY_ROUTE } from "../src/ids.ts";

describe("client/server constant parity", () => {
	it("keeps the browser copy of the WorkBuddy route id in sync with the host", () => {
		// The client bundle cannot import `src/ids.ts` (it re-exports the
		// `dsh-coding-oauth-core` root, which pulls undici and therefore Node
		// builtins), so the route id is duplicated in `client/constants.ts`. This
		// test is what stops the two copies from drifting: a provider id the model
		// selector reports must match the one the badge maps.
		expect(CLIENT_WORKBUDDY_ROUTE).toBe(SERVER_WORKBUDDY_ROUTE);
	});
});

describe("coinstall entry dispatch", () => {
	it("dispatches usage-stats:open-settings with tab accounts and never open-dashboard", () => {
		const dispatched: CustomEvent[] = [];
		const fakeWindow = {
			dispatchEvent: vi.fn((event: Event) => {
				dispatched.push(event as CustomEvent);
				return true;
			}),
		};

		vi.stubGlobal("window", fakeWindow);
		vi.stubGlobal(
			"CustomEvent",
			class MockCustomEvent {
				type: string;
				detail: unknown;
				constructor(type: string, init?: { detail?: unknown }) {
					this.type = type;
					this.detail = init?.detail;
				}
			},
		);

		try {
			openHubAccountsSettings();
			expect(fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1);
			expect(dispatched[0]?.type).toBe("usage-stats:open-settings");
			expect(dispatched[0]?.detail).toEqual({ tab: "accounts" });
			expect(dispatched.some((e) => e.type === "usage-stats:open-dashboard")).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
