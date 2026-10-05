/**
 * Plugin-owned same-origin Web routes for the capability-settings namespace.
 * Arbitrary Host settings namespaces are not remotely exposed, so this plugin
 * publishes only the secret-free snapshot and the two optional read surfaces.
 * @module dsh-coding-subscription-oauth/capability-routes
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CapabilitySettings, type CapabilitySettingsPatch, type CapabilitySettingsSnapshot } from "./capability-settings.js";
import { type OwnerRequestPolicy } from "./web-origin.js";
export { CAPABILITY_SETTINGS_PATH, CODEX_USAGE_PATH, IMAGINE_CREDENTIAL_STATUS_PATH, SEARCH_PROVIDER_PATH, } from "./ids.js";
/** Structural `ctx.webServer` + `ctx.effect` surface used by the registrar. */
export interface CapabilityRouteContext {
    readonly webServer: {
        register(route: {
            kind: "exact" | "prefix";
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
    };
    effect(callback: () => () => void | Promise<void>, label?: string): unknown;
}
/** Owner-facing subset of {@link import("./capability-settings.js").CapabilitySettingsController}. */
export interface CapabilityRouteController {
    snapshot(): CapabilitySettingsSnapshot;
    current(): CapabilitySettings;
    patch(patch: CapabilitySettingsPatch, expectedRevision: number): Promise<CapabilitySettingsSnapshot>;
    replace(section: CapabilitySettingsPatch, expectedRevision: number): Promise<CapabilitySettingsSnapshot>;
}
/** Secret-free Imagine credential probe returned on the optional status route. */
export interface ImagineCredentialStatus {
    readonly configured: boolean;
    readonly source: string;
    readonly writable: boolean;
}
export interface CapabilityRouteOptions {
    readonly controller: CapabilityRouteController;
    readonly usage?: () => unknown | Promise<unknown>;
    readonly credentialInfo?: () => unknown | Promise<unknown>;
    /** Read or change the pinned DSH web search provider. */
    readonly searchProvider?: SearchProviderRouteSurface | undefined;
    readonly ownerRequestPolicy?: OwnerRequestPolicy;
}
/** Minimal surface the search-provider route needs from the settings helper. */
export interface SearchProviderRouteSurface {
    snapshot(): unknown;
    select(value: unknown): Promise<unknown>;
}
/** Register the plugin-owned capability routes. Owns and returns the route disposer. */
export declare function registerCapabilityRoutes(ctx: CapabilityRouteContext, options: CapabilityRouteOptions): () => void;
//# sourceMappingURL=capability-routes.d.ts.map