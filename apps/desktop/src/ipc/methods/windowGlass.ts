import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as WindowGlass from "../../window/WindowGlass.ts";
import {
  GET_WINDOW_GLASS_STATE_CHANNEL,
  SET_WINDOW_GLASS_ENABLED_CHANNEL,
} from "../../window/windowGlassChannels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const WindowGlassStateSchema = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  active: Schema.Boolean,
});

export const getWindowGlassState = DesktopIpc.makeSyncIpcMethod({
  channel: GET_WINDOW_GLASS_STATE_CHANNEL,
  result: WindowGlassStateSchema,
  handler: Effect.fn("desktop.ipc.windowGlass.getState")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return WindowGlass.getWindowGlassState(environment.platform);
  }),
});

export const setWindowGlassEnabled = DesktopIpc.makeIpcMethod({
  channel: SET_WINDOW_GLASS_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: WindowGlassStateSchema,
  handler: Effect.fn("desktop.ipc.windowGlass.setEnabled")(function* (enabled) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    WindowGlass.setWindowGlassEnabled(enabled);
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window)) {
      return WindowGlass.getWindowGlassState(environment.platform);
    }
    const dark = yield* electronTheme.shouldUseDarkColors;
    return WindowGlass.syncWindowGlass(
      window.value,
      environment.platform,
      WindowGlass.opaqueWindowBackground(dark),
    );
  }),
});
