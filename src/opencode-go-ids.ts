/**
 * Plugin-owned OpenCode Go identifiers.
 *
 * Isolated from the pi-ai builtin provider id `opencode-go` so DSH-native Go
 * and this plugin's connect → apply → chat path do not share settings or
 * session-header hooks.
 */

export const OPENCODE_GO_PROVIDER_ID = "coding-opencode-go" as const;

/**
 * Display name for the isolated provider profile.
 *
 * DSH's model picker groups models by the profile `displayName`, so without
 * this the group would read as the raw id `coding-opencode-go`.
 */
export const OPENCODE_GO_DISPLAY_NAME = "OpenCode Go" as const;
/** Historical plugin takeover target / pi-ai builtin id. */
export const OPENCODE_GO_LEGACY_PROVIDER_ID = "opencode-go" as const;

export const OPENCODE_GO_GATEWAY_PREFIX = `${OPENCODE_GO_PROVIDER_ID}/` as const;
export const OPENCODE_GO_LEGACY_GATEWAY_PREFIX = `${OPENCODE_GO_LEGACY_PROVIDER_ID}/` as const;

export function isOpenCodeGoGatewayModel(model: string): boolean {
	return model.startsWith(OPENCODE_GO_GATEWAY_PREFIX) || model.startsWith(OPENCODE_GO_LEGACY_GATEWAY_PREFIX);
}

export function stripOpenCodeGoGatewayPrefix(model: string): string | undefined {
	if (model.startsWith(OPENCODE_GO_GATEWAY_PREFIX)) return model.slice(OPENCODE_GO_GATEWAY_PREFIX.length);
	if (model.startsWith(OPENCODE_GO_LEGACY_GATEWAY_PREFIX)) return model.slice(OPENCODE_GO_LEGACY_GATEWAY_PREFIX.length);
	return undefined;
}

export function openCodeGoGatewayModelId(modelId: string): string {
	return `${OPENCODE_GO_PROVIDER_ID}/${modelId}`;
}
