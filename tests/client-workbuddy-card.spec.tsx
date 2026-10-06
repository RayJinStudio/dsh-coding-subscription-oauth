/** @vitest-environment jsdom */
/**
 * WorkBuddy card, rendered: check-in gating, the read-only credential story,
 * context-length tiers, and the model checkboxes.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkBuddyCard, contextTiersFor, formatContextTier } from "../src/client/components/WorkBuddyCard.tsx";
import { en } from "../src/client/locales.ts";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const t = (key: keyof typeof en) => en[key];

function view(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider: { state: "signed-in", region: "cn", domain: "www.workbuddy.cn", expiresAtMs: Date.now() + 3_600_000 },
		catalog: {
			source: "live",
			models: [
				{ id: "glm-5.3", name: "GLM-5.3", contextWindow: 1_000_000, nativeContextWindow: 1_000_000, maxTokens: 64_000, creditMultiplier: 0.79, takesImages: false, reasoning: true, enabled: true },
				{ id: "hy3", name: "Hy3", contextWindow: 192_000, nativeContextWindow: 192_000, maxTokens: 64_000, creditMultiplier: 0, takesImages: false, reasoning: false, enabled: true },
			],
			enabledModelIds: ["glm-5.3", "hy3"],
			selectionExplicit: false,
			contextBudgets: {},
		},
		authFiles: [
			{
				path: "C:/auth/workbuddy-desktop.info",
				displayPath: "~/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info",
				source: "desktop",
				active: true,
				readable: true,
				region: "cn",
				accountName: "Buddy",
			},
			{
				path: "C:/auth/workbuddy-desktop.bak.info",
				displayPath: "~/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.bak.info",
				source: "desktop",
				active: false,
				readable: false,
				reason: "encrypted",
			},
		],
		desktopFilePresent: true,
		checkinSupported: true,
		checkin: {
			active: true,
			todayCheckedIn: false,
			streakDays: 3,
			dailyCredit: 100,
			todayCredit: 100,
			isStreakDay: false,
			nextStreakDay: 0,
			streakBonusDays: 0,
			streakBonusCredit: 0,
		},
		credits: { totalCount: 2, totalRemaining: 1500, packages: [] },
		...overrides,
	};
}

function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
	const fn = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
	vi.stubGlobal("fetch", fn);
	return fn;
}

const mount = async (payload: unknown) => {
	const fn = stubFetch(payload);
	render(createElement(WorkBuddyCard, { t }));
	await waitFor(() => {
		expect(screen.queryByRole("status", { name: "" })?.textContent ?? "").not.toBe("");
	});
	return fn;
};

/** Like `mount`, but also returns the rendered container for text-level assertions. */
const mountAndReturn = async (payload: unknown) => {
	const fn = await mount(payload);
	return { fn, container: document.body };
};

describe("contextTiersFor", () => {
	it("never offers a tier above the model's own window", () => {
		// A tier the model cannot reach would persist a budget that `Math.min`
		// silently discards, so the radio would read as a chosen downgrade while
		// changing nothing.
		expect(contextTiersFor(1_000_000)).toEqual([200_000, 500_000, 1_000_000]);
		expect(contextTiersFor(256_000)).toEqual([200_000, 256_000]);
		expect(contextTiersFor(192_000)).toEqual([192_000]);
	});

	it("does not duplicate the native tier when it coincides with a preset", () => {
		expect(contextTiersFor(200_000)).toEqual([200_000]);
		expect(contextTiersFor(500_000)).toEqual([200_000, 500_000]);
		expect(contextTiersFor(500_000).filter((tier) => tier === 500_000)).toHaveLength(1);
	});

	it("formats tiers compactly", () => {
		expect(formatContextTier(200_000)).toBe("200K");
		expect(formatContextTier(500_000)).toBe("500K");
		expect(formatContextTier(1_000_000)).toBe("1M");
		expect(formatContextTier(960_000)).toBe("960K");
	});
});

describe("WorkBuddyCard", () => {
	it("shows the account, credits and the check-in action", async () => {
		await mount(view());
		await waitFor(() => {
			// The title and the description both name WorkBuddy, so this is an
			// "at least one" check rather than a uniqueness claim.
			expect(screen.getAllByText(/WorkBuddy/).length).toBeGreaterThan(0);
		});
		expect(screen.getByText(/www\.workbuddy\.cn/)).toBeTruthy();
		expect(screen.getByRole("button", { name: en.workbuddyCheckinAction })).toBeTruthy();
	});

	it("disables the check-in button once today's reward is taken", async () => {
		await mount(view({ checkin: { ...(view().checkin as object), todayCheckedIn: true } }));
		const button = await screen.findByRole("button", { name: en.workbuddyCheckinDone });
		expect((button as HTMLButtonElement).disabled).toBe(true);
	});

	it("renders one check-in button for the whole account, not one per model", async () => {
		// The reference's single-account route was superseded by the batch route;
		// either way a check-in is an ACCOUNT action, so it must not be per-model.
		await mount(view());
		await screen.findByRole("button", { name: en.workbuddyCheckinAction });
		const buttons = screen.getAllByRole("button", { name: en.workbuddyCheckinAction });
		expect(buttons).toHaveLength(1);
	});

	it("offers no login form, because the desktop app owns the sign-in", async () => {
		await mount(view({ provider: { state: "signed-out" }, checkin: undefined, credits: undefined }));
		await waitFor(() => {
			expect(screen.getByText(en.workbuddySignedOutHint)).toBeTruthy();
		});
		expect(screen.queryByRole("button", { name: en.workbuddyCheckinAction })).toBeNull();
		expect(screen.queryByLabelText(/device code/iu)).toBeNull();
	});

	it("explains the encrypted-credential case without telling the user to sign in again", async () => {
		await mount(view({ provider: { state: "signed-out" }, checkin: undefined, credits: undefined }));
		const hint = await screen.findByText(en.workbuddyEncryptedHint);
		// Re-authenticating cannot help: the app, not the account, is what is missing.
		expect(hint.textContent).toMatch(/desktop app/u);
		expect(hint.textContent).toMatch(/will not change this/u);
	});

	it("renders the context-length tiers per model", async () => {
		await mount(view());
		await screen.findByText("GLM-5.3");
		// The 1M model gets three tiers; the 192K model only its own.
		expect(screen.getAllByText("200K").length).toBeGreaterThan(0);
		expect(screen.getByText(/1M · /u)).toBeTruthy();
		expect(screen.getByText("192K · " + en.workbuddyContextNative)).toBeTruthy();
	});

	it("keeps a DISABLED model's checkbox on the page so it can be switched back on", async () => {
		// Regression: the card used to receive only the enabled models, so switching
		// one off removed the very checkbox needed to re-enable it.
		await mount(
			view({
				catalog: {
					...(view().catalog as object),
					models: [
						{ id: "on", name: "On", contextWindow: 100_000, nativeContextWindow: 100_000, maxTokens: 1000, takesImages: false, reasoning: false, enabled: true },
						{ id: "off", name: "Off", contextWindow: 100_000, nativeContextWindow: 100_000, maxTokens: 1000, takesImages: false, reasoning: false, enabled: false },
					],
					enabledModelIds: ["on"],
					selectionExplicit: true,
				},
			}),
		);
		await screen.findByText("Off");
		const labels = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(labels).toHaveLength(2);
		const offBox = labels.find((box) => box.checked === false);
		expect(offBox).toBeDefined();
		// Unchecked but PRESENT and clickable, which is the whole point.
		expect((offBox as HTMLInputElement).disabled).toBe(false);
	});

	it("renders the REMAINING credit per package, monthly rows included", async () => {
		// Regression: a monthly package's package-level `CapacityRemain` stays at the
		// full allocation, so reading it made the card show the TOTAL credit. The
		// upstream plugin now reports the cycle figure as `remaining`, and every
		// package is listed because the aggregate alone cannot say which is running
		// out. Interpolating `t` is required here: the card asserts on the numbers,
		// and the default test `t` returns the raw template.
		const interpolating = (key: keyof typeof en, params?: Record<string, unknown>): string =>
			en[key].replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
		const payload = view({
			credits: {
				totalCount: 2,
				totalRemaining: 1571,
				packages: [
					{
						accountId: 1,
						dealName: "monthly",
						packageName: "CodeBuddy personal",
						capacityType: 4,
						capacityUnit: "credits",
						remaining: 71,
						total: 500,
						monthly: true,
						cycleEndTime: "2026-10-31 23:59:59",
					},
					{
						accountId: 2,
						dealName: "gift",
						packageName: "Gift pack",
						capacityType: 1,
						capacityUnit: "credits",
						remaining: 1500,
						total: 1500,
						monthly: false,
					},
				],
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })),
		);
		render(
			createElement(WorkBuddyCard, {
				t: interpolating as unknown as typeof t,
			}),
		);
		await screen.findByText(/CodeBuddy personal/u);
		// The monthly row shows its CYCLE remainder, not the untouched 500 allocation.
		expect(screen.getByText(/^CodeBuddy personal: 71 \/ 500 · this cycle/u)).toBeTruthy();
		expect(screen.getByText(/^Gift pack: 1500 \/ 1500/u)).toBeTruthy();
		expect(screen.getByText("Remaining credits: 1571 credits left across 2 package(s)")).toBeTruthy();
	});

	it("lists discovered auth files as cards, by account and role rather than by path", async () => {
		await mount(view());
		// The account is the heading; the role distinguishes the app's live
		// sign-in from a rotation backup.
		await screen.findByText("Buddy");
		expect(screen.getByText(en.workbuddyAuthFilePrimary)).toBeTruthy();
		expect(screen.getByText(en.workbuddyAuthFileBackup)).toBeTruthy();
		expect(screen.getByText(en.workbuddyAuthFileActive)).toBeTruthy();
		expect(screen.getByText(en.workbuddyAuthFileDefault)).toBeTruthy();
	});

	it("never renders the credential file location", async () => {
		// The path is long, identical across candidates bar the last segment, and
		// dominated the section while telling the user nothing they act on. The
		// account and the rotation stamp are what identify a file.
		const { container } = await mountAndReturn(view());
		await screen.findByText("Buddy");
		const text = container.textContent ?? "";
		expect(text).not.toContain("CodeBuddyExtension");
		expect(text).not.toContain("workbuddy-desktop.info");
		expect(text).not.toContain("C:/auth");
		// An unnamed file still identifies itself by role instead of by path.
		expect(text).not.toContain(".bak.info");
	});

	it("explains an unreadable file in words, not with a reason code", async () => {
		await mount(view());
		await screen.findByText("Buddy");
		// The wire reason is `encrypted`; the card must not print the raw token.
		expect(screen.getByText(en.workbuddyAuthReasonEncrypted)).toBeTruthy();
		expect(screen.queryByText(/\(encrypted\)/u)).toBeNull();
	});

	it("labels a backup with the rotation stamp parsed out of its name", async () => {
		// The plugin's own copy is named by role, and a timestamped backup shows
		// the stamp the app embedded — derived, not the raw filename.
		await mount(
			view({
				authFiles: [
					{
						path: "C:/auth/workbuddy-desktop.2026-10-04T14-44-28-667Z.16980.469cd190.info",
						displayPath: "~/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.2026-10-04T14-44-28-667Z.16980.469cd190.info",
						source: "desktop",
						active: false,
						readable: true,
						region: "cn",
						accountName: "Q弟",
					},
					{
						path: "C:/Users/t/.dsh/.workbuddy-auth.cn.json",
						displayPath: "~/.dsh/.workbuddy-auth.cn.json",
						source: "dsh",
						active: false,
						readable: true,
						region: "cn",
					},
				],
			}),
		);
		await screen.findByText("Q弟");
		expect(screen.getByText(`${en.workbuddyAuthFileBackup} · 2026-10-04 14:44`)).toBeTruthy();
		// A `.dsh` copy carries no stamp, so it shows its role alone.
		expect(screen.getByText(en.workbuddyAuthFileSourceDsh)).toBeTruthy();
		// The unnamed copy is labelled rather than left blank.
		expect(screen.getByText(en.workbuddyAuthFileAccountUnknown)).toBeTruthy();
	});

	it("offers the auth-file switcher when signed OUT, which is when it is needed", async () => {
		// The moment discovery points at the wrong file is exactly when the card
		// reads as signed out, so hiding the switcher then would be backwards.
		await mount(view({ provider: { state: "signed-out" }, checkin: undefined, credits: undefined }));
		await screen.findByText(en.workbuddySignedOutHint);
		expect(screen.getByText(en.workbuddyAuthFileDefault)).toBeTruthy();
		expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
	});

	it("reports a failed status load instead of rendering an empty card", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })),
		);
		render(createElement(WorkBuddyCard, { t }));
		await waitFor(() => {
			expect(screen.getByText("boom")).toBeTruthy();
		});
	});
});
