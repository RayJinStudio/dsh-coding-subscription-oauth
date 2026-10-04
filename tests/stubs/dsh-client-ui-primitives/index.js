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

/** Test stand-in: no anchoring in jsdom, the panel keeps its measure style. */
export const useAnchoredPosition = () => null;

/** Test stand-in: jsdom tests never assert outside-pointer dismissal. */
export const useDismissOnOutsidePointer = () => undefined;

/** Test stand-in: the host glyph renders nothing. */
export const IconDataOutlineRegular = () => null;
