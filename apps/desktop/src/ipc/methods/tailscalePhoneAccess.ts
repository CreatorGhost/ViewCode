import { DesktopTailscalePhoneAccessSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopTailscalePhoneAccess from "../../backend/DesktopTailscalePhoneAccess.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getTailscalePhoneAccess = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_TAILSCALE_PHONE_ACCESS_CHANNEL,
  payload: Schema.Void,
  result: DesktopTailscalePhoneAccessSchema,
  handler: Effect.fn("desktop.ipc.tailscalePhoneAccess.get")(function* () {
    const phoneAccess = yield* DesktopTailscalePhoneAccess.DesktopTailscalePhoneAccess;
    return yield* phoneAccess.get;
  }),
});

export const setTailscalePhoneAccessAutomatic = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TAILSCALE_PHONE_ACCESS_AUTOMATIC_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopTailscalePhoneAccessSchema,
  handler: Effect.fn("desktop.ipc.tailscalePhoneAccess.setAutomatic")(function* (automatic) {
    const phoneAccess = yield* DesktopTailscalePhoneAccess.DesktopTailscalePhoneAccess;
    return yield* phoneAccess.setAutomatic(automatic);
  }),
});
