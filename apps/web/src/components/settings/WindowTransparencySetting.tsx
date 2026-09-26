import { useState, useSyncExternalStore } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Mirrors `WindowGlassState` in apps/desktop/src/window/windowGlassChannels.ts. */
interface WindowGlassState {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
}

interface WindowGlassBridge {
  getState: () => WindowGlassState;
  setEnabled: (enabled: boolean) => Promise<WindowGlassState>;
  onChange: (listener: (state: WindowGlassState) => void) => () => void;
}

declare global {
  interface Window {
    /** Exposed by the desktop preload (apps/desktop/src/window/windowGlassPreload.ts). */
    viewcodeWindowGlass?: WindowGlassBridge;
  }
}

const noopSubscribe = () => () => {};

// The context bridge clones on every call, so the snapshot is a string key
// (a stable value for useSyncExternalStore) rather than the returned object.
function useWindowGlassState(bridge: WindowGlassBridge | undefined): WindowGlassState | null {
  const key = useSyncExternalStore(
    bridge ? bridge.onChange : noopSubscribe,
    () => {
      if (!bridge) return null;
      const { supported, enabled, active } = bridge.getState();
      return `${supported ? 1 : 0}${enabled ? 1 : 0}${active ? 1 : 0}`;
    },
    () => null,
  );
  if (key === null) return null;
  return { supported: key[0] === "1", enabled: key[1] === "1", active: key[2] === "1" };
}

/**
 * Desktop only: the see-through window (macOS vibrancy, Windows 11 Mica).
 * Changes apply live; the OS "Reduce transparency" setting always wins.
 */
export function WindowTransparencySetting() {
  const bridge = typeof window === "undefined" ? undefined : window.viewcodeWindowGlass;
  const state = useWindowGlassState(bridge);
  const [isUpdating, setIsUpdating] = useState(false);
  if (!bridge || !state) return null;

  const description = !state.supported
    ? "Needs macOS or Windows 11. This system keeps a solid window."
    : state.enabled && !state.active
      ? "Paused because Reduce transparency is on in your system settings."
      : "Let the desktop show through the window, tinted by your theme.";

  return (
    <SettingsRow
      {...searchableSetting("window-transparency")}
      description={description}
      control={
        <Switch
          checked={state.supported && state.enabled}
          disabled={!state.supported || isUpdating}
          onCheckedChange={(checked) => {
            setIsUpdating(true);
            void bridge.setEnabled(checked).finally(() => setIsUpdating(false));
          }}
          aria-label="Window transparency"
        />
      }
    />
  );
}
