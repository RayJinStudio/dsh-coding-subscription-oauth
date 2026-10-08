/** Coding-subscription adapter assembled from public dsh-llm-pi-ai extension points. */
import type { AttachmentStore } from "@deepseek-ai/dsh-attachment";
import type { RetryPolicyConfig } from "@deepseek-ai/dsh-llm";
import { type LlmAdapter } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { OAuthProviderSession } from "./oauth-session.js";
import type { GrokBuildSession } from "./session.js";
import type { WorkBuddySession } from "./workbuddy-session.js";
/** Prefer grok-4.6 when the current (live or baseline) list has it. */
export declare function preferredGrokBuildModel(models?: readonly {
    id: string;
}[]): string;
/** Existing Grok-only constructor retained for public API compatibility. */
export declare function createGrokBuildAdapter(session: GrokBuildSession, resolveAttachments: () => AttachmentStore | undefined): PiAiAdapter;
/** Opt-in Codex Fast wiring; ordinary `codex-oauth` is unchanged when this is omitted. */
export interface CodingOAuthAdapterOptions {
    retryPolicy?: RetryPolicyConfig;
    codexFast?: {
        isEligible(modelId: string): boolean;
    };
    /**
     * WorkBuddy session, when the route should be served.
     *
     * Unlike the OAuth subscriptions this is not a login provider: the credential
     * comes from the WorkBuddy desktop app, so the session owns discovery,
     * refresh, the live roster and the per-model context budgets.
     */
    workbuddy?: WorkBuddySession;
    /**
     * OpenCode Zen, when the route should be served.
     *
     * Not an OAuth login either: the credential is a Zen API key the operator
     * stores through the credentials service. `models` is a live closure because
     * the enabled set is settings-card state, and the route serves whatever
     * protocols the enabled models name — that is what
     * {@link opencodeZenProvider} exists for, since DSH settings can only name
     * one protocol per route.
     */
    opencodeZen?: {
        models: () => readonly Model<Api>[];
        resolveApiKey: () => Promise<string | undefined>;
    };
}
/** Create the four-route OAuth adapter while preserving each pi-ai native id. */
export declare function createCodingOAuthAdapter(grok: GrokBuildSession, subscriptions: readonly OAuthProviderSession[], resolveAttachments: () => AttachmentStore | undefined, retryPolicy?: RetryPolicyConfig, options?: CodingOAuthAdapterOptions): LlmAdapter;
export declare function createCodingOAuthAdapter(grok: GrokBuildSession, subscriptions: readonly OAuthProviderSession[], resolveAttachments: () => AttachmentStore | undefined, options?: CodingOAuthAdapterOptions): LlmAdapter;
//# sourceMappingURL=adapter.d.ts.map