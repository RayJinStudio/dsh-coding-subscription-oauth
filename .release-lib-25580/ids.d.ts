/** Compatibility facade for stable identifiers owned by dsh-coding-oauth-core. */
export type { CodingOAuthOptionalRoute, CodingOAuthProviderSlug, CodingOAuthRoute, } from "dsh-coding-oauth-core";
export { ANTIGRAVITY_ROUTE, CAPABILITY_SETTINGS_NAMESPACE, CAPABILITY_SETTINGS_PATH, CLAUDE_CODE_OAUTH_AUTH_FILENAME, CLAUDE_CODE_OAUTH_MODELS_CACHE_FILENAME, CLAUDE_CODE_OAUTH_ROUTE, CLAUDE_PI_PROVIDER, CODEX_OAUTH_AUTH_FILENAME, CODEX_OAUTH_FAST_ROUTE, CODEX_OAUTH_MODELS_CACHE_FILENAME, CODEX_OAUTH_ROUTE, CODEX_PI_PROVIDER, CODEX_USAGE_PATH, CODING_OAUTH_LOGIN_CANCEL_PATH, CODING_OAUTH_LOGIN_CODE_PATH, CODING_OAUTH_LOGIN_PATH, CODING_OAUTH_LOGOUT_PATH, CODING_OAUTH_MANAGEMENT_PATHS, CODING_OAUTH_MODELS_PATH, CODING_OAUTH_OPTIONAL_ROUTES, CODING_OAUTH_ROUTES, CODING_OAUTH_STATE_SCHEMA_VERSION, CODING_OAUTH_STATUS_PATH, DEFAULT_GROK_BUILD_MODEL, GATEWAY_KEY_FILENAME, GATEWAY_REVEAL_PATH, GATEWAY_ROTATE_PATH, GATEWAY_SETTINGS_PATH, GROK_BUILD_AUTH_FILENAME, GROK_BUILD_AUTH_IMPORT_PATH, GROK_BUILD_AUTH_LOGIN_CANCEL_PATH, GROK_BUILD_AUTH_LOGIN_CODE_PATH, GROK_BUILD_AUTH_LOGIN_PATH, GROK_BUILD_AUTH_LOGOUT_PATH, GROK_BUILD_AUTH_MODELS_PATH, GROK_BUILD_AUTH_STATUS_PATH, GROK_BUILD_MODELS_CACHE_FILENAME, GROK_BUILD_ROUTE, GROK_BUILD_STREAM_IDLE_TIMEOUT_MS, IMAGINE_CREDENTIAL_STATUS_PATH, IMAGINE_MEDIA_STORE_DIRNAME, KIMI_CODE_OAUTH_AUTH_FILENAME, KIMI_CODE_OAUTH_MODELS_CACHE_FILENAME, KIMI_CODE_OAUTH_ROUTE, KIMI_PI_PROVIDER, OAUTH_IMPORT_CANCEL_PATH, OAUTH_IMPORT_COMMIT_PATH, OAUTH_IMPORT_PREVIEW_PATH, OAUTH_IMPORT_SOURCES_PATH, XAI_PI_PROVIDER, } from "dsh-coding-oauth-core";
/** Multi-account mutations (peer core contracts do not list these yet). */
export declare const CODING_OAUTH_API_BASE: "/plugins/dsh-grok-build";
/**
 * Harness route for the WorkBuddy provider.
 *
 * Kept local rather than in `dsh-coding-oauth-core`: that package publishes a
 * frozen route tuple for the four OAuth subscription routes, and WorkBuddy is
 * not an OAuth login this plugin performs — it reuses the desktop app's
 * sign-in. The route id is nonetheless a first-class route everywhere the
 * adapter and the optional-route rebinding are concerned.
 *
 * The value is `workbuddy-oauth`, NOT `workbuddy`. The reference plugin
 * `dsh-connect-workbuddy` owns `workbuddy` (its CN route) and `workbuddy-global`,
 * and `ctx.llm.registerAdapter` refuses the ENTIRE route list when any single
 * provider is already claimed. Reusing the id would therefore make the two
 * plugins mutually exclusive: whichever loads second loses every route it owns
 * and silently serves the other's catalog and wire path. A distinct id lets both
 * run at once, which is also what makes this one independently testable.
 */
export declare const WORKBUDDY_ROUTE: "workbuddy-oauth";
/**
 * OpenCode Zen route served by this plugin's own multi-protocol provider.
 *
 * Aliased to the Zen id module's constant so the adapter, the route list here,
 * and the settings card cannot drift. Deliberately NOT pi-ai's builtin
 * `opencode` id: DSH mounts that route from the installed catalogue, and
 * `registerAdapter` is all-or-nothing, so claiming it would withdraw this
 * plugin's unrelated routes.
 */
export declare const OPENCODE_ZEN_ROUTE: "coding-opencode-zen";
/**
 * Every route this plugin's LLM adapter serves, in registration order.
 *
 * Exists because the optional Codex Fast route is published by REPLACING the
 * whole route list, so any route missing from that list is silently withdrawn
 * the first time Fast eligibility is reconciled.
 */
export declare const CODING_OAUTH_ALL_ROUTES: readonly string[];
export declare const CODING_OAUTH_ACCOUNTS_SET_ACTIVE_PATH: "/plugins/dsh-grok-build/oauth/accounts/set-active";
export declare const CODING_OAUTH_ACCOUNTS_REMOVE_PATH: "/plugins/dsh-grok-build/oauth/accounts/remove";
export declare const CODING_OAUTH_SUBSCRIPTION_USAGE_PATH: "/plugins/dsh-grok-build/oauth/usage";
export declare const KIMI_USAGE_PATH: "/plugins/dsh-grok-build/kimi/usage";
/** Effective DSH web search provider pin, read and written through the profile config editor. */
export declare const SEARCH_PROVIDER_PATH: "/plugins/dsh-grok-build/web/search-provider";
/** WorkBuddy account/catalog snapshot (read-only). */
export declare const WORKBUDDY_STATUS_PATH: "/plugins/dsh-grok-build/workbuddy/status";
/** WorkBuddy daily check-in; a real one-per-day grant, called only by explicit user action. */
export declare const WORKBUDDY_CHECKIN_PATH: "/plugins/dsh-grok-build/workbuddy/checkin";
/** WorkBuddy model selection and per-model context budgets. */
export declare const WORKBUDDY_MODELS_PATH: "/plugins/dsh-grok-build/workbuddy/models";
//# sourceMappingURL=ids.d.ts.map