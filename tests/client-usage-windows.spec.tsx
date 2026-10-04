/** @vitest-environment jsdom */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCard, type ProviderCardProps } from "../src/client/components/ProviderCard.tsx";
import { PROVIDERS } from "../src/client/constants.ts";
import { usageWindowLabelKey } from "../src/client/display.ts";
import { en } from "../src/client/locales.ts";
import type { UsageView } from "../src/client/types.ts";

afterEach(cleanup);

const signedIn = {
	status: "signed-in" as const,
	provider: "kimi" as const,
	route: "kimi",
	displayName: "Kimi",
	loginMethods: ["browser" as const],
	recommendedLoginMethod: "browser" as const,
	models: ["model-a"],
	available: ["model-a"],
	selected: ["model-a"],
	accounts: [{ id: "account-a", expires: 2_000_000_000_000 }],
	activeAccountId: "account-a",
};

/** The exact projection `parseKimiUsageView` builds from the live Kimi payload. */
function kimiUsage(): UsageView {
	return {
		rateLimits: [
			{ id: "kimi-0", windows: [{ usedPercent: 0, remainingPercent: 100, windowSeconds: 18_000, resetsAt: 1_800_000_000 }] },
			{ id: "kimi-1", windows: [{ usedPercent: 1, remainingPercent: 99, windowSeconds: 604_800, resetsAt: 1_800_500_000 }] },
		],
		fetchedAt: 1_791_127_102_552,
	};
}

function props(usage: UsageView): ProviderCardProps {
	return {
		t: (key) => en[key],
		definition: PROVIDERS.find((item) => item.slug === "kimi")!,
		providerStatus: signedIn,
		busy: false,
		sourcesBusy: false,
		remote: false,
		codeInput: "",
		popupBlocked: false,
		expanded: true,
		source: undefined,
		showUsage: true,
		usage,
		usageError: undefined,
		usageLoading: false,
		onSignIn: vi.fn(),
		onSignOut: vi.fn(),
		onCancelLogin: vi.fn(),
		onSubmitCode: vi.fn(),
		onCodeChange: vi.fn(),
		onToggleExpanded: vi.fn(),
		onPreviewSource: vi.fn(),
		onSaveModels: vi.fn(async () => undefined),
		onSetDefaultAccount: vi.fn(),
		onRemoveAccount: vi.fn(async () => true),
		onRetryStatus: vi.fn(),
	};
}

describe("usage window bars", () => {
	it("draws one bar per reported window instead of repeating the first one", () => {
		render(createElement(ProviderCard, props(kimiUsage())));
		// fixture reports a 5-hour window plus a weekly summary
		expect(screen.getAllByRole("progressbar")).toHaveLength(2);
	});

	it("labels the windows by length instead of the generic rate-limit copy", () => {
		render(createElement(ProviderCard, props(kimiUsage())));
		expect(screen.getByText(en.usageLimitSession)).toBeTruthy();
		expect(screen.getByText(en.usageLimitWeekly)).toBeTruthy();
		expect(screen.queryByText(en.usageRateLimit)).toBeNull();
	});

	it("keeps a vendor-supplied window name when the payload has one", () => {
		const usage = kimiUsage();
		usage.rateLimits[0]!.name = "Primary";
		render(createElement(ProviderCard, props(usage)));
		expect(screen.getByText("Primary")).toBeTruthy();
		expect(screen.getByText(en.usageLimitWeekly)).toBeTruthy();
	});

	it("still shows a distinct bar when a spend limit exists", () => {
		const usage = kimiUsage();
		usage.individualRemainingPercent = 40;
		render(createElement(ProviderCard, props(usage)));
		expect(screen.getAllByRole("progressbar")).toHaveLength(3);
		expect(screen.getByText(en.usageIndividualLimit)).toBeTruthy();
	});

	it("reads every window of a limit instead of only the first", () => {
		// Codex packs primary_window + secondary_window into one rate limit.
		const usage = kimiUsage();
		usage.rateLimits = [
			{
				id: "codex",
				windows: [
					{ usedPercent: 25, windowSeconds: 18_000 },
					{ usedPercent: 60, windowSeconds: 604_800 },
				],
			},
		];
		render(createElement(ProviderCard, props(usage)));
		expect(screen.getAllByRole("progressbar")).toHaveLength(2);
		expect(screen.getByText(en.usageLimitSession)).toBeTruthy();
		expect(screen.getByText(en.usageLimitWeekly)).toBeTruthy();
	});

	it("qualifies each window when a named limit carries several windows", () => {
		const usage = kimiUsage();
		usage.rateLimits = [
			{ id: "codex", name: "Codex", windows: [{ usedPercent: 25, windowSeconds: 18_000 }, { usedPercent: 60, windowSeconds: 604_800 }] },
		];
		render(createElement(ProviderCard, props(usage)));
		expect(screen.getByText(`Codex · ${en.usageLimitSession}`)).toBeTruthy();
		expect(screen.getByText(`Codex · ${en.usageLimitWeekly}`)).toBeTruthy();
	});
});

describe("usageWindowLabelKey", () => {
	it("classifies 5-hour, weekly, and unknown windows", () => {
		expect(usageWindowLabelKey(18_000)).toBe("usageLimitSession");
		expect(usageWindowLabelKey(3_600)).toBe("usageLimitSession");
		expect(usageWindowLabelKey(604_800)).toBe("usageLimitWeekly");
		expect(usageWindowLabelKey(undefined)).toBe("usageRateLimit");
		expect(usageWindowLabelKey(0)).toBe("usageRateLimit");
		expect(usageWindowLabelKey(86_400)).toBe("usageRateLimit");
	});
});
