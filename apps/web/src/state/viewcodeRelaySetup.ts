import { createViewCodeRelaySetupAtoms } from "@t3tools/client-runtime/state/viewcode-relay-setup";

import { connectionAtomRuntime } from "../connection/runtime";

export const viewCodeRelaySetupEnvironment = createViewCodeRelaySetupAtoms(connectionAtomRuntime);
