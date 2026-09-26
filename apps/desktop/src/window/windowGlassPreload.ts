import { contextBridge, ipcRenderer } from "electron";

import {
  GET_WINDOW_GLASS_STATE_CHANNEL,
  SET_WINDOW_GLASS_ENABLED_CHANNEL,
  WINDOW_GLASS_STATE_CHANNEL,
  type WindowGlassState,
} from "./windowGlassChannels.ts";

// Renderer-side storage for the "Window transparency" preference. It is a
// per-device window setting, so it stays out of the synced client settings
// contract; the preload reads it before the window is first shown.
const STORAGE_KEY = "viewcode:window-glass";
const UNSUPPORTED: WindowGlassState = { supported: false, enabled: false, active: false };

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeStoredEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The preference then lasts for this session only.
  }
}

function isWindowGlassState(value: unknown): value is WindowGlassState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.supported === "boolean" &&
    typeof state.enabled === "boolean" &&
    typeof state.active === "boolean"
  );
}

/**
 * Exposes `window.viewcodeWindowGlass` and keeps `html[data-window-glass]` in
 * step with the main process, so viewcode-theme.css can drop the opaque
 * backgrounds while the OS draws vibrancy or Mica behind the page.
 */
export function exposeWindowGlass(): void {
  const initial = ipcRenderer.sendSync(GET_WINDOW_GLASS_STATE_CHANNEL);
  let state = isWindowGlassState(initial) ? initial : UNSUPPORTED;
  const listeners = new Set<(state: WindowGlassState) => void>();

  const applyAttribute = () => {
    const root = document.documentElement;
    if (!root) return;
    if (state.active) root.dataset.windowGlass = "true";
    else delete root.dataset.windowGlass;
  };
  const publish = (next: WindowGlassState) => {
    state = next;
    applyAttribute();
    for (const listener of listeners) listener(next);
  };
  const setEnabled = async (enabled: boolean): Promise<WindowGlassState> => {
    writeStoredEnabled(enabled);
    const next: unknown = await ipcRenderer.invoke(SET_WINDOW_GLASS_ENABLED_CHANNEL, enabled);
    if (isWindowGlassState(next)) publish(next);
    return state;
  };

  if (state.supported && state.enabled !== readStoredEnabled()) {
    // Paint the stored choice now; main catches up before the window shows.
    const enabled = !state.enabled;
    state = { ...state, enabled, active: state.active && enabled };
    void setEnabled(enabled);
  }
  applyAttribute();
  window.addEventListener("DOMContentLoaded", applyAttribute, { once: true });
  ipcRenderer.on(WINDOW_GLASS_STATE_CHANNEL, (_event, next: unknown) => {
    if (isWindowGlassState(next)) publish(next);
  });

  contextBridge.exposeInMainWorld("viewcodeWindowGlass", {
    getState: () => state,
    setEnabled,
    onChange: (listener: (state: WindowGlassState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}
