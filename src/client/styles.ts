/** Shared inline styles using DSH design tokens. */

import type { CSSProperties } from "react";
import type { ProviderStatus } from "./types.ts";

export const TRANSITION = "all 0.15s ease";

export const pageStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 16,
	width: "100%",
	maxWidth: 780,
	minWidth: 0,
};
export const titleStyle: CSSProperties = {
	margin: 0,
	fontSize: 18,
	lineHeight: "26px",
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)",
};
export const bodyStyle: CSSProperties = {
	margin: 0,
	fontSize: 13,
	lineHeight: "20px",
	color: "var(--dsw-alias-label-secondary)",
};
export const cardStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 16,
	padding: "16px 20px",
	border: "0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))",
	borderRadius: "var(--dsw-radius-xl, 20px)",
	background: "var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))",
	transition: TRANSITION,
};
export const rowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: 12,
};
export const statusStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	fontSize: 13,
	fontWeight: 500,
	color: "var(--dsw-alias-label-primary)",
};
export const buttonStyle: CSSProperties = {
	boxSizing: "border-box",
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	gap: 6,
	height: 38,
	minHeight: 38,
	padding: "0 14px",
	border: "0.5px solid var(--dsw-alias-border-l3)",
	borderRadius: "var(--dsw-radius-md, 12px)",
	background: "transparent",
	color: "var(--dsw-alias-label-primary)",
	boxShadow: "none",
	font: "inherit",
	fontSize: 14,
	lineHeight: "22px",
	fontWeight: 500,
	cursor: "pointer",
	transition: TRANSITION,
};
export const primaryButtonStyle: CSSProperties = {
	...buttonStyle,
	// DSH dark theme flips brand-primary to near-white; use the button/foreground
	// pair so primary CTAs stay readable in both light and dark mode.
	border: "none",
	background: "var(--dsw-alias-button-primary-fill)",
	color: "var(--dsw-alias-label-primary-foreground)",
	fontWeight: 500,
};
export const compactButtonStyle: CSSProperties = {
	...buttonStyle,
};
export const compactPrimaryButtonStyle: CSSProperties = {
	...primaryButtonStyle,
};
export const errorStyle: CSSProperties = { ...bodyStyle, color: "var(--dsw-alias-state-error-primary)" };
export const successStyle: CSSProperties = { ...bodyStyle, color: "var(--dsw-alias-state-success-primary, #22a06b)" };
export const warningStyle: CSSProperties = {
	...bodyStyle,
	padding: "10px 14px",
	borderRadius: "var(--dsw-radius-lg, 16px)",
	border: "0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e06c00) 30%, transparent)",
	background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary, #e06c00) 8%, transparent)",
	color: "var(--dsw-alias-label-primary)",
};
export const tipStyle: CSSProperties = {
	...bodyStyle,
	padding: "10px 14px",
	borderRadius: "var(--dsw-radius-lg, 16px)",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	background: "var(--dsw-alias-bg-module-platform)",
	color: "var(--dsw-alias-label-primary)",
};
export const noticeStyle: CSSProperties = {
	...tipStyle,
	animation: "dsh-coding-oauth-fade-in 0.2s ease",
};
export const codeStyle: CSSProperties = {
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	fontSize: 16,
	letterSpacing: "0.06em",
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)",
};
export const monoStyle: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
export const snippetStyle: CSSProperties = {
	...monoStyle,
	display: "block",
	fontSize: 12,
	lineHeight: "18px",
	padding: "10px 14px",
	borderRadius: "var(--dsw-radius-md, 12px)",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-primary)",
	overflowWrap: "anywhere",
	whiteSpace: "pre-wrap",
};
export const linkStyle: CSSProperties = {
	color: "var(--dsw-alias-link, var(--dsw-alias-brand-primary))",
	fontWeight: 500,
	textDecoration: "none",
	wordBreak: "break-all",
	cursor: "pointer",
};
export const listStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 6,
	margin: 0,
	padding: 0,
	listStyle: "none",
};
export const checkRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	fontSize: 13,
	color: "var(--dsw-alias-label-primary)",
	cursor: "pointer",
};
export const inputStyle: CSSProperties = {
	boxSizing: "border-box",
	width: "100%",
	height: 38,
	minHeight: 38,
	padding: "0 12px",
	border: "0.5px solid var(--dsw-alias-border-l4)",
	borderRadius: "var(--dsw-radius-md, 12px)",
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit",
	fontSize: 14,
	lineHeight: "22px",
	transition: TRANSITION,
};
export const nestedStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 10,
	padding: "14px 16px",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	borderRadius: "var(--dsw-radius-lg, 16px)",
	background: "var(--dsw-alias-bg-module-platform)",
};
export const hintStyle: CSSProperties = {
	...bodyStyle,
	fontSize: 12,
	lineHeight: "18px",
	color: "var(--dsw-alias-label-tertiary)",
};
export const visuallyHiddenStyle: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	padding: 0,
	margin: -1,
	overflow: "hidden",
	clip: "rect(0, 0, 0, 0)",
	whiteSpace: "nowrap",
	border: 0,
};
export const segmentedNavStyle: CSSProperties = {
	display: "inline-flex",
	flexWrap: "wrap",
	gap: 2,
	padding: 3,
	borderRadius: "var(--dsw-radius-lg, 16px)",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	background: "var(--dsw-alias-bg-module-platform)",
};
export const segmentedTabStyle: CSSProperties = {
	...buttonStyle,
	border: "none",
	borderRadius: "var(--dsw-radius-md, 12px)",
	boxShadow: "none",
	background: "transparent",
	height: 32,
	minHeight: 32,
	padding: "0 12px",
	fontSize: 13,
	color: "var(--dsw-alias-label-secondary)",
};
export const segmentedTabActiveStyle: CSSProperties = {
	...segmentedTabStyle,
	background: "var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-1))",
	border: "0.5px solid var(--dsw-alias-border-l3)",
	color: "var(--dsw-alias-label-primary)",
	boxShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
	fontWeight: 600,
};
export const panelStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	gap: 14,
	minWidth: 0,
};
export const accountGridStyle: CSSProperties = {
	display: "grid",
	gridTemplateColumns: "repeat(auto-fill, minmax(min(340px, 100%), 1fr))",
	gap: 14,
};
export const copyRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: 8,
};
export const skeletonStyle: CSSProperties = {
	...cardStyle,
	minHeight: 88,
	background:
		"linear-gradient(90deg, var(--dsw-alias-bg-layer-1) 0%, var(--dsw-alias-bg-module-platform) 50%, var(--dsw-alias-bg-layer-1) 100%)",
	backgroundSize: "200% 100%",
	animation: "dsh-coding-oauth-skeleton-pulse 1.4s ease-in-out infinite",
};
export const stepRowStyle: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: 10,
	fontSize: 13,
	color: "var(--dsw-alias-label-secondary)",
};
export const stepActiveStyle: CSSProperties = {
	...stepRowStyle,
	color: "var(--dsw-alias-label-primary)",
	fontWeight: 500,
};
export const stepNumberStyle: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	width: 20,
	height: 20,
	borderRadius: "50%",
	flex: "0 0 auto",
	fontSize: 11,
	fontWeight: 600,
	background: "var(--dsw-alias-bg-module-platform)",
	border: "0.5px solid var(--dsw-alias-border-l3)",
	color: "var(--dsw-alias-label-secondary)",
};
export const stepNumberActiveStyle: CSSProperties = {
	...stepNumberStyle,
	background: "var(--dsw-alias-button-primary-fill)",
	border: "none",
	color: "var(--dsw-alias-label-primary-foreground)",
};

export type StatusTone = "success" | "error" | "warning" | "info" | "neutral";

export function statusToneColor(tone: StatusTone): string {
	switch (tone) {
		case "success":
			return "var(--dsw-alias-state-success-primary, #22a06b)";
		case "error":
			return "var(--dsw-alias-state-error-primary, #d92d20)";
		case "warning":
			// DSH token is `state-warn-*` (not `state-warning-*`).
			return "var(--dsw-alias-state-warn-primary, #e06c00)";
		case "info":
			// Accent/text color (not a solid fill + white text pair).
			return "var(--dsw-alias-brand-primary, #1677ff)";
		default:
			// Prefer tertiary over dimmed: dimmed is near-invisible on light cards
			// and too dark on dark cards.
			return "var(--dsw-alias-label-tertiary, #81858c)";
	}
}

export function badgeStyle(tone: StatusTone): CSSProperties {
	const color = statusToneColor(tone);
	const isNeutral = tone === "neutral";
	return {
		display: "inline-flex",
		alignItems: "center",
		gap: 5,
		padding: "2px 8px",
		borderRadius: 999,
		fontSize: 11,
		fontWeight: 500,
		lineHeight: "17px",
		color,
		background: isNeutral ? "var(--dsw-alias-bg-module-platform)" : `color-mix(in srgb, ${color} 10%, transparent)`,
		border: isNeutral
			? "0.5px solid var(--dsw-alias-border-l3)"
			: `0.5px solid color-mix(in srgb, ${color} 22%, transparent)`,
		whiteSpace: "nowrap",
	};
}

export function dotStyle(
	status: ProviderStatus["status"] | "loading" | "available" | "unavailable",
	installed = true,
): CSSProperties {
	const color = !installed
		? "var(--dsw-alias-label-tertiary, #81858c)"
		: status === "signed-in" || status === "available"
			? "var(--dsw-alias-state-success-primary, #22a06b)"
			: status === "error"
				? "var(--dsw-alias-state-error-primary, #d92d20)"
				: status === "signing-in" || status === "loading"
					? "var(--dsw-alias-brand-primary, #1677ff)"
					: "var(--dsw-alias-label-tertiary, #81858c)";
	return {
		width: 7,
		height: 7,
		borderRadius: "50%",
		flex: "0 0 auto",
		background: color,
	};
}

export function providerStatusTone(status: ProviderStatus["status"], installed = true): StatusTone {
	if (!installed) return "neutral";
	if (status === "signed-in") return "success";
	if (status === "error") return "error";
	if (status === "signing-in") return "info";
	return "neutral";
}
