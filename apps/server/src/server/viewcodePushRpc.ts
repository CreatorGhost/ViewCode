import { type AuthSessionId, type PushRegisterInput, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Push from "../notifications/PushNotifications.ts";

/** The session comes from the authenticated socket, never from a client-supplied id. */
export const make = (sessionId: AuthSessionId) =>
  Effect.gen(function* () {
    const push = yield* Push.PushNotifications;
    return {
      [WS_METHODS.pushRegister]: (input: PushRegisterInput) => push.register(sessionId, input),
      [WS_METHODS.pushUnregister]: () => push.unregister(sessionId),
    };
  });
