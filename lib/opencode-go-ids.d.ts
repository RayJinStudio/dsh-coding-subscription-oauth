/**
 * Plugin-owned OpenCode Go identifiers.
 *
 * Isolated from the pi-ai builtin provider id `opencode-go` so DSH-native Go
 * and this plugin's connect → apply → chat path do not share settings or
 * session-header hooks.
 */
export declare const OPENCODE_GO_PROVIDER_ID: "coding-opencode-go";
/**
 * Display name for the isolated provider profile.
 *
 * DSH's model picker groups models by the profile `displayName`, so without
 * this the group would read as the raw id `coding-opencode-go`.
 */
export declare const OPENCODE_GO_DISPLAY_NAME: "OpenCode Go";
/** Historical plugin takeover target / pi-ai builtin id. */
export declare const OPENCODE_GO_LEGACY_PROVIDER_ID: "opencode-go";
export declare const OPENCODE_GO_GATEWAY_PREFIX: "coding-opencode-go/";
export declare const OPENCODE_GO_LEGACY_GATEWAY_PREFIX: "opencode-go/";
export declare function isOpenCodeGoGatewayModel(model: string): boolean;
export declare function stripOpenCodeGoGatewayPrefix(model: string): string | undefined;
export declare function openCodeGoGatewayModelId(modelId: string): string;
//# sourceMappingURL=opencode-go-ids.d.ts.map