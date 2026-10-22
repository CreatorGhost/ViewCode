export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}

/** The always-visible AppRail strip left of the sidebar (`w-12`, `--app-rail-width: 3rem`). */
export const APP_RAIL_WIDTH = 3 * 16;
/**
 * Below this viewport width the rail, a minimum sidebar and a minimum main column no
 * longer fit side by side, so the thread sidebar becomes an overlay sheet instead.
 */
export const THREAD_SIDEBAR_OVERLAY_BREAKPOINT =
  APP_RAIL_WIDTH + THREAD_SIDEBAR_MIN_WIDTH + THREAD_MAIN_CONTENT_MIN_WIDTH;

/**
 * The width the thread sidebar and the main column share: the window less the rail. The
 * width helpers above take this, not the window width, or a narrow window squeezes main.
 */
export function threadLayoutWidth(viewportWidth: number): number {
  return viewportWidth - APP_RAIL_WIDTH;
}
