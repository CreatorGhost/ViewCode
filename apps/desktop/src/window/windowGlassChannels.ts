// Shared by the main process and the sandboxed preload, so this file must not
// import Node or Electron main-process modules.

/** Sync: the renderer asks for the current glass state at load. */
export const GET_WINDOW_GLASS_STATE_CHANNEL = "desktop:viewcode-get-window-glass-state";
/** Invoke: the renderer turns window transparency on or off. */
export const SET_WINDOW_GLASS_ENABLED_CHANNEL = "desktop:viewcode-set-window-glass-enabled";
/** Push: main tells the renderer the glass state changed (preference or OS setting). */
export const WINDOW_GLASS_STATE_CHANNEL = "desktop:viewcode-window-glass-state";

export interface WindowGlassState {
  /** The platform can draw a see-through window (macOS, Windows 11 22H2+). */
  readonly supported: boolean;
  /** The user's "Window transparency" preference. */
  readonly enabled: boolean;
  /** The window is see-through right now: supported, enabled, and the OS does not ask to reduce transparency. */
  readonly active: boolean;
}
