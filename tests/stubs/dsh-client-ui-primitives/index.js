/**
 * jsdom stub for the host's browser primitive kit.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is supplied by the DSH web shell at
 * runtime (it is a PLATFORM_MODULE of `@deepseek-ai/dsh-client-web`), so it is
 * not a dependency of this package. jsdom tests alias it here to keep the
 * badge's component tests runnable without pulling the whole UI kit in.
 *
 * Only the members the badge imports are provided; anything else a future
 * client component needs must be added explicitly.
 */
import { createElement } from "react";

/** Test stand-in: no anchoring in jsdom, the panel keeps its measure style. */
export const useAnchoredPosition = () => null;

/** Test stand-in: jsdom tests never assert outside-pointer dismissal. */
export const useDismissOnOutsidePointer = () => undefined;

/**
 * Test stand-in for one host glyph.
 *
 * Renders a real `<svg>` carrying `width`/`height`, so a spec can assert the
 * size the badge passes. It deliberately mirrors the host's prop handling: the
 * real artwork destructures exactly `size`, `className`, and `strokeWidth`, so a
 * `style` prop is DISCARDED. Reproducing that here is what caught the badge
 * passing `style={{ flex: "none" }}` to a component that silently ignored it.
 */
function glyph({ size = 16, className }) {
	return createElement("svg", { width: size, height: size, className, "aria-hidden": true });
}

export const IconDataOutlineRegular = glyph;
export const IconDataOutline16 = glyph;
