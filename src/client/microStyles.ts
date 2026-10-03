/** Injects global keyframes once for skeleton pulse and spinner animations. */

const STYLE_ID = "dsh-coding-oauth-micro-styles";

const CSS = `
@keyframes dsh-coding-oauth-skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes dsh-coding-oauth-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes dsh-coding-oauth-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
[data-dsh-coding-oauth] [role="switch"],
[data-dsh-coding-oauth] [role="switch"] > span,
[data-dsh-coding-oauth] [role="status"],
[data-dsh-coding-oauth] [role="progressbar"],
[data-dsh-coding-oauth] [role="progressbar"] > div {
  corner-shape: round;
}
[data-dsh-coding-oauth] button:focus-visible,
[data-dsh-coding-oauth] input:focus-visible,
[data-dsh-coding-oauth] select:focus-visible,
[data-dsh-coding-oauth] [role="switch"]:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
[data-dsh-coding-oauth] input::placeholder {
  color: var(--dsw-alias-label-dimmed, #81858c);
}
[data-dsh-coding-oauth] input:focus,
[data-dsh-coding-oauth] select:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
[data-dsh-coding-oauth] input[type="checkbox"] {
  accent-color: var(--dsw-alias-brand-primary, #1677ff);
  cursor: pointer;
  width: 15px;
  height: 15px;
}
[data-dsh-coding-oauth] a {
  color: var(--dsw-alias-link, var(--dsw-alias-brand-primary));
  text-decoration: none;
}
[data-dsh-coding-oauth] a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
[data-dsh-coding-oauth] button:hover:not(:disabled) {
  opacity: 0.92;
}
[data-dsh-coding-oauth] button:active:not(:disabled) {
  opacity: 0.82;
}
[data-dsh-coding-oauth] * {
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, rgba(127, 127, 127, 0.3)) transparent;
}
[data-dsh-coding-oauth] ::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
[data-dsh-coding-oauth] ::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, rgba(127, 127, 127, 0.3));
  border-radius: 999px;
}
[data-dsh-coding-oauth] ::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1, rgba(127, 127, 127, 0.5));
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-coding-oauth] *, [data-dsh-coding-oauth] *::before, [data-dsh-coding-oauth] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
@media (max-width: 560px) {
  /* 仅对本插件的宿主设置页调整双栏布局，保留其他页面的宿主样式。 */
  [role="dialog"]:has([data-dsh-coding-oauth="management"]) { flex-direction: column; }
  [role="dialog"]:has([data-dsh-coding-oauth="management"]) > nav {
    width: 100%; flex: 0 0 auto; padding: 12px; box-sizing: border-box;
  }
  [role="dialog"]:has([data-dsh-coding-oauth="management"]) > nav > div:last-child {
    flex-direction: row; overflow-x: auto; min-width: 0;
  }
  [role="dialog"]:has([data-dsh-coding-oauth="management"]) > nav button {
    flex: 0 0 auto; white-space: nowrap;
  }
  [role="dialog"]:has([data-dsh-coding-oauth="management"]) > nav + div { width: 100%; min-height: 0; }
  [data-dsh-coding-oauth="management"] input,
  [data-dsh-coding-oauth="management"] select { min-width: 0; max-width: 100%; box-sizing: border-box; }
  [data-dsh-coding-oauth] button,
  [data-dsh-coding-oauth] input,
  [data-dsh-coding-oauth] [role="switch"] {
    min-height: 44px;
  }
  [data-dsh-coding-oauth] [data-responsive-row] {
    align-items: stretch !important;
    flex-direction: column;
  }
}
`;

let injected = false;

export function ensureMicroStyles(): void {
	if (injected || typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID) !== null) {
		injected = true;
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
	injected = true;
}
