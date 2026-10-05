/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilitiesTab, type CapabilitiesTabProps } from "../src/client/components/CapabilitiesTab.tsx";
import { emptyCapabilitySettings } from "../src/client/parsers.ts";
import { en } from "../src/client/locales.ts";

afterEach(cleanup);

function props(overrides: Partial<CapabilitiesTabProps> = {}): CapabilitiesTabProps {
	return {
		t: (key) => en[key],
		capabilities: { value: emptyCapabilitySettings(), revision: 1, writable: true },
		capabilitiesError: undefined,
		capabilitiesBusy: false,
		imagine: { configured: false, source: "none" },
		imagineError: undefined,
		codexSignedIn: false,
		kimiSignedIn: false,
		onRetry: vi.fn(),
		onOpenAccounts: vi.fn(),
		onFocusDependency: vi.fn(),
		onPatchCapability: vi.fn(),
		...overrides,
	};
}

function toggle(key: string): HTMLInputElement {
	return screen.getByRole("switch", { name: en[key === "kimiSearch" ? "capKimiSearch" : "capCodexSearch"] }) as HTMLInputElement;
}

describe("capabilities tab scoping", () => {
	it("shows only the Kimi search toggle on the Kimi card", () => {
		render(createElement(CapabilitiesTab, props({ scope: "kimi" })));
		expect(toggle("kimiSearch")).toBeTruthy();
		expect(screen.queryByRole("switch", { name: en.capCodexSearch })).toBeNull();
		// Grok Imagine toggles belong to the Grok card.
		expect(screen.queryByRole("switch", { name: en.capGrokImagineImage })).toBeNull();
		expect(screen.queryByText(en.imagineTitle)).toBeNull();
	});

	it("shows only the Codex search toggle on the Codex card", () => {
		render(createElement(CapabilitiesTab, props({ scope: "codex" })));
		expect(screen.queryByRole("switch", { name: en.capKimiSearch })).toBeNull();
		expect(screen.queryByRole("switch", { name: en.capCodexSearch })).toBeTruthy();
	});

	it("enables the Kimi toggle from the Kimi sign-in, not the Codex one", () => {
		render(createElement(CapabilitiesTab, props({ scope: "kimi", kimiSignedIn: true, codexSignedIn: false })));
		expect(toggle("kimiSearch").disabled).toBe(false);
		expect(screen.queryByText(en.requiresKimiSignIn)).toBeNull();
	});

	it("disables the Kimi toggle with a Kimi-specific reason while signed out", () => {
		render(createElement(CapabilitiesTab, props({ scope: "kimi", kimiSignedIn: false, codexSignedIn: true })));
		expect(toggle("kimiSearch").disabled).toBe(true);
		// The reason must name Kimi: a Kimi-only user must not be told to sign in to Codex.
		expect(screen.getByText(en.requiresKimiSignIn)).toBeTruthy();
		expect(screen.getByRole("button", { name: en.openKimiAccount })).toBeTruthy();
		expect(screen.queryByText(en.requiresCodexSignIn)).toBeNull();
	});

	it("keeps the unscoped capabilities tab listing every toggle", () => {
		render(createElement(CapabilitiesTab, props()));
		expect(screen.getByRole("switch", { name: en.capCodexSearch })).toBeTruthy();
		expect(screen.getByRole("switch", { name: en.capKimiSearch })).toBeTruthy();
		expect(screen.getByRole("switch", { name: en.capGrokImagineImage })).toBeTruthy();
	});
});
