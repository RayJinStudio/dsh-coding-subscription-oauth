/** Dismissible notice banner with optional auto-hide. */

import { useEffect } from "react";
import { bodyStyle, compactButtonStyle, noticeStyle } from "../styles.ts";

export interface NoticeBannerProps {
	message: string;
	dismissLabel?: string;
	onDismiss?: () => void;
	autoHideMs?: number;
	tone?: "info" | "success";
}

export function NoticeBanner({ message, dismissLabel, onDismiss, autoHideMs, tone = "info" }: NoticeBannerProps) {
	useEffect(() => {
		if (autoHideMs === undefined || onDismiss === undefined) return;
		const timer = window.setTimeout(onDismiss, autoHideMs);
		return () => {
			window.clearTimeout(timer);
		};
	}, [autoHideMs, onDismiss]);

	const toneColor =
		tone === "success" ? "var(--dsw-alias-state-success-primary, #22a06b)" : "var(--dsw-alias-brand-primary, #1677ff)";

	return (
		<div
			style={{
				...noticeStyle,
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
				borderRadius: "var(--dsw-radius-lg, 16px)",
				border: `0.5px solid color-mix(in srgb, ${toneColor} 30%, transparent)`,
				background: `color-mix(in srgb, ${toneColor} 8%, var(--dsw-alias-bg-module-platform))`,
				padding: "10px 14px",
			}}
			role="status"
		>
			<div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
				<span
					aria-hidden="true"
					style={{
						width: 6,
						height: 6,
						borderRadius: "50%",
						background: toneColor,
						flexShrink: 0,
					}}
				/>
				<p style={{ ...bodyStyle, margin: 0, color: "var(--dsw-alias-label-primary)" }}>{message}</p>
			</div>
			{onDismiss === undefined || dismissLabel === undefined ? null : (
				<button type="button" style={compactButtonStyle} onClick={onDismiss}>
					{dismissLabel}
				</button>
			)}
		</div>
	);
}
