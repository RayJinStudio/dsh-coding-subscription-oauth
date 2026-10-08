/**
 * Plugin-owned OpenCode Zen identifiers.
 *
 * Deliberately distinct from pi-ai's builtin `opencode` route. DSH already
 * mounts that route natively from the installed catalogue, and
 * `ctx.llm.registerAdapter` is all-or-nothing, so taking over the builtin id
 * would both fight the native route and withdraw this plugin's unrelated
 * routes. A distinct id also keeps this route's session-header shaping and
 * card state from colliding with the builtin catalogue.
 *
 * The operator's own hand-written `opencodezen` route is intentionally NOT
 * referenced here: this plugin neither reads nor migrates it.
 */
export declare const OPENCODE_ZEN_PROVIDER_ID: "coding-opencode-zen";
/** Zen inference base. Individual catalogue models carry their own `baseUrl`. */
export declare const OPENCODE_ZEN_BASE_URL: "https://opencode.ai/zen/v1";
export declare const OPENCODE_ZEN_DISPLAY_NAME: "OpenCode Zen";
/** Credential references the Zen card offers, in preference order. */
export declare const OPENCODE_ZEN_KNOWN_REFS: readonly ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"];
/** Environment variable that pins the fingerprinted client version. */
export declare const OPENCODE_ZEN_UA_ENV: "OPENCODE_ZEN_USER_AGENT";
//# sourceMappingURL=opencode-zen-ids.d.ts.map