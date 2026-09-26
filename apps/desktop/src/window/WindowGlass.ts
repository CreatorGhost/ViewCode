import * as NodeOS from "node:os";

import * as Electron from "electron";

import { WINDOW_GLASS_STATE_CHANNEL, type WindowGlassState } from "./windowGlassChannels.ts";

/**
 * ViewCode's see-through window (docs/design/droppy-look.md §3.2): macOS
 * vibrancy or Windows 11 Mica behind a transparent page. The renderer paints
 * its scrim and tint layers under `html[data-window-glass="true"]`
 * (apps/web/src/viewcode-theme.css), which the preload sets from
 * {@link WindowGlassState.active}. Linux and Windows 10 stay opaque.
 */
export type WindowGlassMaterial = "vibrancy" | "mica";

const TRANSPARENT = "#00000000";
// Windows 11 22H2, the first build where DWM system backdrops are settable.
const MIN_WINDOWS_MICA_BUILD = 22_621;

/** The window colour when glass is off: `--vc-window` (droppy-look.md §3.1). */
export function opaqueWindowBackground(dark: boolean): string {
  return dark ? "#1F1F21" : "#EDEDEF";
}

export function resolveWindowGlassMaterial(
  platform: NodeJS.Platform,
  osRelease: string,
): WindowGlassMaterial | null {
  if (platform === "darwin") return "vibrancy";
  if (platform === "win32") {
    const build = Number(osRelease.split(".")[2]);
    return Number.isInteger(build) && build >= MIN_WINDOWS_MICA_BUILD ? "mica" : null;
  }
  return null;
}

// The user's preference lives in the renderer's storage (the preload reports
// it at load, before the window is first shown); main keeps the last value so
// windows opened later in the session start in the right state.
let glassEnabled = true;

export function setWindowGlassEnabled(enabled: boolean): void {
  glassEnabled = enabled;
}

function prefersReducedTransparency(): boolean {
  try {
    return Electron.nativeTheme.prefersReducedTransparency === true;
  } catch {
    return false;
  }
}

export function getWindowGlassState(platform: NodeJS.Platform): WindowGlassState {
  const supported = resolveWindowGlassMaterial(platform, NodeOS.release()) !== null;
  return {
    supported,
    enabled: glassEnabled,
    active: supported && glassEnabled && !prefersReducedTransparency(),
  };
}

/** Constructor options for a new main window; spread after `backgroundColor`. */
export function windowGlassConstructorOptions(
  platform: NodeJS.Platform,
): Partial<Electron.BrowserWindowConstructorOptions> {
  if (!getWindowGlassState(platform).active) return {};
  const material = resolveWindowGlassMaterial(platform, NodeOS.release());
  if (material === "vibrancy") {
    return {
      vibrancy: "under-window",
      visualEffectState: "followWindow",
      backgroundColor: TRANSPARENT,
    };
  }
  if (material === "mica") {
    return { backgroundMaterial: "mica", backgroundColor: TRANSPARENT };
  }
  return {};
}

/**
 * Applies the current glass state to a live window and tells its renderer.
 * `opaqueBackground` is the window colour used when glass is off.
 */
export function syncWindowGlass(
  window: Electron.BrowserWindow,
  platform: NodeJS.Platform,
  opaqueBackground: string,
): WindowGlassState {
  const state = getWindowGlassState(platform);
  if (window.isDestroyed()) return state;
  const material = resolveWindowGlassMaterial(platform, NodeOS.release());
  if (material === "vibrancy") {
    window.setVibrancy(state.active ? "under-window" : null);
  } else if (material === "mica") {
    window.setBackgroundMaterial(state.active ? "mica" : "none");
  }
  window.setBackgroundColor(state.active ? TRANSPARENT : opaqueBackground);
  if (material !== null) {
    window.webContents.send(WINDOW_GLASS_STATE_CHANNEL, state);
  }
  return state;
}
