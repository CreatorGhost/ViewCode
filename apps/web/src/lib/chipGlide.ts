import { observeResize } from "./observeResize";

export interface ChipBox {
  readonly left: number;
  readonly width: number;
}

export interface ChipGlide {
  readonly dx: number;
  readonly scaleX: number;
}

/**
 * How a chip glides from its last layout box to its new one, or null when it stays put. A chip
 * that only moved slides back from its old place. A chip that changed width tweens its surface
 * from the old box when it has one; its content has already cut to the new state, so a chip
 * without a surface does not move. Hidden rows (zero width), first measurements and reduced
 * motion never glide.
 */
export function planChipGlide(
  previous: ChipBox | undefined,
  next: ChipBox,
  options: { readonly hasSurface: boolean; readonly reducedMotion: boolean },
): ChipGlide | null {
  if (options.reducedMotion || previous === undefined) return null;
  if (previous.width === 0 || next.width === 0) return null;
  const dx = previous.left - next.left;
  const scaleX = previous.width / next.width;
  if (Math.abs(scaleX - 1) < 0.005) return Math.abs(dx) < 0.5 ? null : { dx, scaleX: 1 };
  return options.hasSurface ? { dx, scaleX } : null;
}

// --dur-chip on --ease-out-chip. Additive, so a change that lands mid-glide adds its own offset
// to the running one instead of jumping.
const GLIDE_TIMING: KeyframeAnimationOptions = {
  duration: 275,
  easing: "cubic-bezier(0.33, 1, 0.68, 1)",
  composite: "add",
};

/**
 * Attach to a positioned row of chips, as a ref or from a layout effect. When a chip changes
 * width, layout snaps at once and the chips it pushed glide to their new places; a chip whose
 * `[data-chip-surface]` child draws its fill and border (positioned over it, `origin-left`)
 * tweens that surface from its old width. Only transforms move, and nothing runs between
 * changes. Reduced motion snaps.
 */
export function observeChipGlide(row: HTMLElement | null) {
  if (row === null) return;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let boxes = new Map<HTMLElement, ChipBox>();

  const sync = (animate: boolean) => {
    const next = new Map<HTMLElement, ChipBox>();
    const reduced = reducedMotion?.matches === true;
    for (const child of row.children) {
      if (!(child instanceof HTMLElement)) continue;
      const origin = child.offsetParent === row ? 0 : row.offsetLeft;
      const box = { left: child.offsetLeft - origin, width: child.offsetWidth };
      next.set(child, box);
      if (!animate) continue;
      const surface = child.querySelector<HTMLElement>(":scope > [data-chip-surface]");
      const plan = planChipGlide(boxes.get(child), box, {
        hasSurface: surface !== null,
        reducedMotion: reduced,
      });
      if (plan === null) continue;
      const target = plan.scaleX === 1 || surface === null ? child : surface;
      target.animate?.(
        [{ transform: `translateX(${plan.dx}px) scaleX(${plan.scaleX})` }, { transform: "none" }],
        GLIDE_TIMING,
      );
    }
    boxes = next;
  };

  let stopObserving = () => {};
  const observe = () => {
    stopObserving();
    // The row resizing on its own (the window, a sidebar) moves nothing worth a glide.
    stopObserving = observeResize([row, ...row.children], (entries) =>
      sync(entries.some((entry) => entry.target !== row)),
    );
  };
  observe();
  sync(false);
  const mutations = new MutationObserver(() => {
    observe();
    sync(true);
  });
  mutations.observe(row, { childList: true });
  return () => {
    stopObserving();
    mutations.disconnect();
  };
}
