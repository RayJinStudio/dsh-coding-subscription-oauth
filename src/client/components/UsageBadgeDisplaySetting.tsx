import { type CSSProperties, useState } from "react";
import type { GrokBuildSettingsKey } from "../locales.ts";
import { setUsageBadgeMode, useUsageBadgeMode } from "../usage-badge-preferences.ts";

type Translate = (key: GrokBuildSettingsKey, params?: Record<string, unknown>) => string;

/** Browser-local display preference; never changes provider or account settings. */
export function UsageBadgeDisplaySetting({ t }: { readonly t: Translate }) {
	const mode = useUsageBadgeMode();
	const [failed, setFailed] = useState(false);
	return (
		<div style={styles.card}>
			<label style={styles.field}>
				<span style={styles.label}>{t("usageBadgeDisplay")}</span>
				<select
					style={styles.select}
					aria-label={t("usageBadgeDisplay")}
					value={mode}
					onChange={(event) => {
						const value = event.currentTarget.value;
						if (value !== "recent" && value !== "hidden") return;
						try {
							setUsageBadgeMode(value);
							setFailed(false);
						} catch (error) {
							if (!(error instanceof DOMException) || !["SecurityError", "QuotaExceededError"].includes(error.name))
								throw error;
							setFailed(true);
						}
					}}
				>
					<option value="recent">{t("usageBadgeDisplayRecent")}</option>
					<option value="hidden">{t("usageBadgeDisplayHidden")}</option>
				</select>
			</label>
			<p style={styles.hint}>{t("usageBadgeDisplayHint")}</p>
			{failed && (
				<p role="alert" style={{ ...styles.hint, color: "var(--dsw-alias-state-error-primary)" }}>
					{t("usageBadgeDisplaySaveFailed")}
				</p>
			)}
		</div>
	);
}

const styles: Record<string, CSSProperties> = {
	card: {
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: "var(--dsw-radius-md, 12px)",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6,
		background: "var(--dsw-alias-bg-layer-1)",
	},
	field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 14, lineHeight: "22px" },
	label: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 },
	select: {
		height: 32,
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: "var(--dsw-radius-sm, 8px)",
		padding: "0 10px",
		font: "inherit",
		fontSize: 13,
		background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))",
		color: "var(--dsw-alias-label-primary)",
	},
	hint: { margin: 0, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
};
