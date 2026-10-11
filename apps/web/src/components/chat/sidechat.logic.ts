/** Whether a scroller sits at (or within a few pixels of) its bottom edge. */
export function isPinnedToBottom(
  scroller: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  tolerancePx = 24,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= tolerancePx;
}
