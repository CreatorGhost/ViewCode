import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Registers this phone's Expo push token with a computer, or tells it to forget the phone. */
export const pushEnvironment = {
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:register",
    tag: WS_METHODS.pushRegister,
  }),
  unregister: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:push:unregister",
    tag: WS_METHODS.pushUnregister,
  }),
};
