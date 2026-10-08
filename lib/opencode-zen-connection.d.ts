/**
 * OpenCode Zen connection controller: the settings card's backend.
 *
 * Shaped like `opencode-go-connection.ts` (status / credential / apply /
 * models) with one decisive difference: Zen spans several wire protocols, so
 * the card selects MODELS and each model's protocol is read from the installed
 * pi-ai catalogue. There is deliberately no `api` field — the protocol belongs
 * to the model, and the route's provider dispatches on it. A DSH-settings
 * route could not do this, because `PiAiProviderProfile.api` is one protocol
 * for the whole route and a per-model `api` is ignored.
 *
 * The enabled selection is stored in this plugin's OWN file under DSH_HOME
 * rather than in the `llm-pi-ai` settings layer. That is deliberate: writing a
 * route into `llm-pi-ai` would either collide with the operator's hand-written
 * `opencodezen` profile or silently do nothing (a mixed-protocol route cannot
 * resolve). The route this plugin serves is built in code by
 * {@link opencodeZenProvider}, so only the selection — not the route — needs
 * persisting.
 *
 * @module dsh-coding-subscription-oauth/opencode-zen-connection
 */
import { type CredentialProvider } from "@deepseek-ai/dsh-credentials";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { OwnerRequestPolicy } from "./web-origin.js";
import { type PluginWebRouteRegistry } from "./web-routes.js";
export declare const OPENCODE_ZEN_CONNECTION_PATH: "/plugins/dsh-grok-build/opencode-zen";
/** Plugin-owned selection document, alongside the other plugin caches. */
export declare const OPENCODE_ZEN_SELECTION_FILENAME: ".opencode-zen-models.json";
export interface OpenCodeZenSelectionDocument {
    readonly version: number;
    /** `default` serves the whole catalogue; `selected` serves `ids` only. */
    readonly selectionMode: "default" | "selected";
    readonly ids: readonly string[];
    /** The credential reference the operator picked, when more than one is configured. */
    readonly credentialRef?: string;
    readonly fetchedAt: number;
}
/** One selectable Zen model, as the card sees it. */
export interface OpenCodeZenModel {
    readonly id: string;
    readonly name?: string;
    readonly protocol: string;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly input?: readonly ("text" | "image")[];
    readonly reasoningEfforts?: false | Record<string, string | null>;
    readonly free: boolean;
}
/** Resolve the plugin-owned selection path beneath DSH_HOME. */
export declare function opencodeZenSelectionPath(dshHome?: string): string;
/** Read the persisted selection; an absent or unreadable file means "everything". */
export declare function readZenSelection(dshHome?: string): Promise<{
    selection: string[] | undefined;
    credentialRef: string | undefined;
    fetchedAt: number;
}>;
/** Persist the selection atomically, owner-readable only. */
export declare function writeZenSelection(state: {
    selection: string[] | undefined;
    credentialRef?: string | undefined;
}, dshHome?: string): Promise<void>;
/**
 * The Zen catalogue as the card sees it.
 *
 * Sourced from pi-ai's installed `opencode` catalogue so a Zen model addition
 * or a protocol change arrives with a pi-ai upgrade rather than a plugin
 * release. A model absent from that catalogue cannot be served by this route,
 * because nothing local would know which protocol to speak.
 */
export declare function opencodeZenCatalog(): OpenCodeZenModel[];
/**
 * The models the route currently serves, in catalogue order.
 *
 * Reads the persisted selection through the optional `dshHome` override so the
 * adapter and the card agree on one source of truth, and so tests can point at
 * an isolated home.
 */
export declare function opencodeZenEnabledModels(dshHome?: string): Promise<Model<Api>[]>;
interface Options {
    credentials: CredentialProvider;
    dshHome?: string;
    onConfigurationChange?: () => void;
    fetchImpl?: typeof fetch;
}
export declare function createOpenCodeZenConnectionController(options: Options): {
    status: (preferredRef?: string) => Promise<{
        providerId: "coding-opencode-zen";
        displayName: "OpenCode Zen";
        baseURL: "https://opencode.ai/zen/v1";
        credential: {
            selectedRef: string;
            configured: boolean;
            writable: boolean;
            source: string | null;
            requiresChoice: boolean;
            candidates: {
                ref: string;
                configured: boolean;
                writable: boolean;
                source: string | null;
            }[];
        };
        configuration: {
            writable: boolean;
            selectionMode: "default" | "selected";
            fetchedAt: number;
            models: OpenCodeZenModel[];
            protocols: string[];
            ready: boolean;
            unknownModels: string[];
            catalogSize: number;
        };
        catalog: OpenCodeZenModel[];
    }>;
    models(): Promise<OpenCodeZenModel[]>;
    saveCredential(input: {
        credentialRef: string;
        apiKey?: string;
    }): Promise<{
        providerId: "coding-opencode-zen";
        displayName: "OpenCode Zen";
        baseURL: "https://opencode.ai/zen/v1";
        credential: {
            selectedRef: string;
            configured: boolean;
            writable: boolean;
            source: string | null;
            requiresChoice: boolean;
            candidates: {
                ref: string;
                configured: boolean;
                writable: boolean;
                source: string | null;
            }[];
        };
        configuration: {
            writable: boolean;
            selectionMode: "default" | "selected";
            fetchedAt: number;
            models: OpenCodeZenModel[];
            protocols: string[];
            ready: boolean;
            unknownModels: string[];
            catalogSize: number;
        };
        catalog: OpenCodeZenModel[];
    }>;
    /**
     * Delete the stored OpenCode Zen key.
     *
     * Removes the value from the credential store rather than writing a blank,
     * for the same reason as the Go route: an empty value resolves as absent,
     * but a leftover record keeps describing the reference as configured. The
     * remembered reference is dropped too, so the card returns to a clean
     * "enter a key" state instead of pointing at an empty slot.
     */
    clearCredential(input: {
        credentialRef: string;
    }): Promise<{
        providerId: "coding-opencode-zen";
        displayName: "OpenCode Zen";
        baseURL: "https://opencode.ai/zen/v1";
        credential: {
            selectedRef: string;
            configured: boolean;
            writable: boolean;
            source: string | null;
            requiresChoice: boolean;
            candidates: {
                ref: string;
                configured: boolean;
                writable: boolean;
                source: string | null;
            }[];
        };
        configuration: {
            writable: boolean;
            selectionMode: "default" | "selected";
            fetchedAt: number;
            models: OpenCodeZenModel[];
            protocols: string[];
            ready: boolean;
            unknownModels: string[];
            catalogSize: number;
        };
        catalog: OpenCodeZenModel[];
    }>;
    /**
     * Persist the enabled model selection.
     *
     * `models: undefined` restores "serve the whole catalogue". Ids the local
     * catalogue does not describe are refused rather than stored, because the
     * route could not dispatch them — their protocol is unknown.
     */
    applyConfiguration(input: {
        models?: readonly string[];
    }): Promise<{
        providerId: "coding-opencode-zen";
        displayName: "OpenCode Zen";
        baseURL: "https://opencode.ai/zen/v1";
        credential: {
            selectedRef: string;
            configured: boolean;
            writable: boolean;
            source: string | null;
            requiresChoice: boolean;
            candidates: {
                ref: string;
                configured: boolean;
                writable: boolean;
                source: string | null;
            }[];
        };
        configuration: {
            writable: boolean;
            selectionMode: "default" | "selected";
            fetchedAt: number;
            models: OpenCodeZenModel[];
            protocols: string[];
            ready: boolean;
            unknownModels: string[];
            catalogSize: number;
        };
        catalog: OpenCodeZenModel[];
    }>;
};
export declare function registerOpenCodeZenConnectionRoute(ctx: {
    webServer: PluginWebRouteRegistry;
    effect(callback: () => () => void, label?: string): unknown;
}, controller: ReturnType<typeof createOpenCodeZenConnectionController>, policy: OwnerRequestPolicy): () => void;
export {};
//# sourceMappingURL=opencode-zen-connection.d.ts.map