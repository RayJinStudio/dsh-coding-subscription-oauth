import { useState } from "react";
import { openCodeGoGatewayModelId } from "../../opencode-go-ids.ts";
import type { GoGatewayRoute } from "../go-gateway-route.ts";
import {
	bodyStyle,
	compactButtonStyle,
	hintStyle,
	monoStyle,
	nestedStyle,
	primaryButtonStyle,
	titleStyle,
	warningStyle,
} from "../styles.ts";

export type { GoGatewayRoute } from "../go-gateway-route.ts";
export type GoGatewayKey =
	| "title"
	| "hint"
	| "migration"
	| "empty"
	| "edit"
	| "apply"
	| "disable"
	| "cancel"
	| "credential";
export function GoGatewayRouteView({
	route,
	preview,
	migration,
	busy,
	onApply,
	t,
}: {
	route?: GoGatewayRoute | null | undefined;
	preview?: GoGatewayRoute | null | undefined;
	migration?: string | undefined;
	busy: boolean;
	onApply: (value: GoGatewayRoute | null) => void;
	t: (key: GoGatewayKey) => string;
}) {
	const [editing, setEditing] = useState(false);
	const chosen = editing ? preview : route;
	return (
		<section style={{ ...nestedStyle, gap: 10 }}>
			<h4 style={{ ...titleStyle, fontSize: 14 }}>{t("title")}</h4>
			<p style={{ ...bodyStyle, margin: 0 }}>{t("hint")}</p>
			{migration === "required" ? (
				<p role="status" style={{ ...warningStyle, margin: 0 }}>
					{t("migration")}
				</p>
			) : null}
			{chosen ? (
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<p style={{ ...bodyStyle, margin: 0 }}>
						{t("credential")}: <span style={monoStyle}>{chosen.credentialRef}</span>
					</p>
					<ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
						{chosen.models.map((model) => (
							<li key={model.id} style={{ ...bodyStyle, fontSize: 12 }}>
								<span style={monoStyle}>{openCodeGoGatewayModelId(model.id)}</span> · {model.protocol}
							</li>
						))}
					</ul>
				</div>
			) : (
				<p style={{ ...hintStyle, margin: 0 }}>{t("empty")}</p>
			)}
			<div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
				{editing ? (
					<>
						<button
							type="button"
							style={primaryButtonStyle}
							disabled={busy || !preview}
							onClick={() => {
								if (!busy && preview) onApply(preview);
							}}
						>
							{t("apply")}
						</button>
						<button type="button" style={compactButtonStyle} disabled={busy} onClick={() => setEditing(false)}>
							{t("cancel")}
						</button>
					</>
				) : (
					<button type="button" style={compactButtonStyle} disabled={busy} onClick={() => setEditing(true)}>
						{t("edit")}
					</button>
				)}
				{route ? (
					<button
						type="button"
						style={compactButtonStyle}
						disabled={busy}
						onClick={() => {
							if (!busy) onApply(null);
						}}
					>
						{t("disable")}
					</button>
				) : null}
			</div>
		</section>
	);
}
