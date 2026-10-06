/**
 * Plugin-owned same-origin Web routes for the WorkBuddy provider: the
 * account/catalog snapshot, the explicit daily check-in, and model selection /
 * per-model context budgets.
 *
 * Every route is behind the same owner-request policy as the rest of the plugin
 * (loopback peer, loopback `Host`, same-origin), and every response is
 * secret-free: no access token, no refresh token, no at-rest key.
 *
 * The check-in is a REAL one-per-day grant on the user's account, so it is a
 * POST that only an explicit click reaches. There is no scheduler here and none
 * should be added: an automatic check-in would spend the user's reward without
 * their knowledge, and the route already skips the claim when the account is
 * checked in.
 *
 * @module dsh-coding-subscription-oauth/workbuddy-routes
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type OwnerRequestPolicy } from "./web-origin.js";
import type { WorkBuddyCredentialStore } from "./workbuddy-auth.js";
import { WORKBUDDY_NATIVE_MODALITY } from "./workbuddy-provider.js";
import type { WorkBuddySession } from "./workbuddy-session.js";
import { type WorkBuddyCheckinClaim, type WorkBuddyCheckinStatus, type WorkBuddyCredits } from "./workbuddy-upstream.js";
export { WORKBUDDY_CHECKIN_PATH, WORKBUDDY_MODELS_PATH, WORKBUDDY_STATUS_PATH } from "./ids.js";
/** Structural `ctx.webServer` + `ctx.effect` surface used by the registrar. */
export interface WorkBuddyRouteContext {
    readonly webServer: {
        register(route: {
            kind: "exact" | "prefix";
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
    };
    effect(callback: () => () => void | Promise<void>, label?: string): unknown;
}
/** One model row as the card needs it: capabilities plus the native window. */
export interface WorkBuddyModelView {
    readonly id: string;
    readonly name: string;
    /** Effective window after the saved budget, which is what DSH uses. */
    readonly contextWindow: number;
    /** The model's own window, which the budget can only lower. */
    readonly nativeContextWindow: number;
    readonly maxTokens: number;
    readonly creditMultiplier?: number;
    readonly takesImages: boolean;
    readonly reasoning: boolean;
    /**
     * Whether this model is currently served to DSH.
     *
     * Every model in the roster is REPORTED, including disabled ones: a card that
     * listed only the enabled models would make switching one off irreversible,
     * because the checkbox needed to switch it back on would disappear with it.
     */
    readonly enabled: boolean;
}
/** One discovered auth file, as the settings card offers it. */
export interface WorkBuddyAuthFileView {
    /** Absolute path; the exact value a switch writes. */
    readonly path: string;
    /** Home-relative rendering for display. */
    readonly displayPath: string;
    readonly source: "desktop" | "dsh";
    /** Whether this file is currently in the probe path. */
    readonly active: boolean;
    readonly readable: boolean;
    readonly region?: "cn" | "global";
    readonly accountName?: string;
    readonly tokenExpiresAtMs?: number;
    readonly reason?: string;
    readonly message?: string;
}
/** Secret-free snapshot the card renders. */
export interface WorkBuddyView {
    readonly provider: {
        readonly state: "signed-in" | "signed-out";
        readonly region?: "cn" | "global";
        readonly expiresAtMs?: number;
        readonly nickname?: string;
        readonly domain?: string;
        readonly source?: "desktop" | "dsh";
    };
    readonly catalog: {
        readonly source: "live" | "cache" | "fallback";
        readonly error?: string;
        readonly models: readonly WorkBuddyModelView[];
        readonly enabledModelIds: readonly string[];
        readonly selectionExplicit: boolean;
        readonly contextBudgets: Readonly<Record<string, number>>;
    };
    /**
     * Every auth file the store can read, plus the one in force.
     *
     * Reported even when no override is set, so the user can see the platform
     * default and pick a different file without knowing its path in advance.
     */
    readonly authFiles: readonly WorkBuddyAuthFileView[];
    /** The override currently in force, when one is set. */
    readonly authFileOverride?: string;
    readonly desktopFilePresent: boolean;
    readonly checkinSupported: boolean;
    readonly checkin?: WorkBuddyCheckinStatus;
    readonly checkinError?: string;
    readonly credits?: WorkBuddyCredits;
    readonly creditsError?: string;
}
/** What a check-in click answered. */
export interface WorkBuddyCheckinResult {
    /** True when the reward was already taken, so no claim was issued. */
    readonly alreadyCheckedIn: boolean;
    readonly claim?: WorkBuddyCheckinClaim;
    /** The status AFTER the action, so the card renders the settled state. */
    readonly checkin: WorkBuddyCheckinStatus;
}
/** The owner-facing surface the routes drive. */
export interface WorkBuddyRouteSurface {
    /** Build the snapshot; `checkin: false` skips the billing calls. */
    snapshot(options?: {
        checkin?: boolean;
    }): Promise<WorkBuddyView>;
    /** Read today's check-in state, then claim it when it is still unclaimed. */
    checkin(): Promise<WorkBuddyCheckinResult>;
    /** Persist the model selection; `selected: undefined` restores "serve every model". */
    setModels(input: {
        selected?: string[];
    }): Promise<WorkBuddyView>;
    /** Persist one model's context budget; `undefined` clears it. */
    setBudget(input: {
        modelId: string;
        budget?: number;
    }): Promise<WorkBuddyView>;
    /** Re-fetch the live roster. */
    refresh(): Promise<WorkBuddyView>;
    /** Point credential discovery at one auth file, or back at the defaults. */
    setAuthFile(path: string | undefined): Promise<WorkBuddyView>;
}
export interface WorkBuddyRouteOptions {
    readonly session: WorkBuddySession;
    readonly store: WorkBuddyCredentialStore;
    readonly ownerRequestPolicy?: OwnerRequestPolicy;
}
/**
 * Build the route surface over a session and its credential store.
 *
 * Billing calls (`check-in` status, credits) are attempted only for a signed-in
 * account and their failures are reported per section rather than failing the
 * whole snapshot: a billing outage must not hide the model list, and vice versa.
 */
export declare function createWorkBuddyRouteSurface(options: WorkBuddyRouteOptions): WorkBuddyRouteSurface;
/** Register the three WorkBuddy routes. Owns and returns the route disposer. */
export declare function registerWorkBuddyRoutes(ctx: WorkBuddyRouteContext, options: WorkBuddyRouteOptions): () => void;
/** The fixed modality table, exposed so tests can pin the policy. */
export { WORKBUDDY_NATIVE_MODALITY };
//# sourceMappingURL=workbuddy-routes.d.ts.map