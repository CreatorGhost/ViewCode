import { createRockBotEnvironmentAtoms } from "@t3tools/client-runtime/state/rockbot";

import { connectionAtomRuntime } from "../connection/runtime";

export const rockBotEnvironment = createRockBotEnvironmentAtoms(connectionAtomRuntime);
