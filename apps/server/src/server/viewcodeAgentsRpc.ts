import { WS_METHODS, type AgentControlInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentMessaging from "../agents/AgentMessagingV2.ts";

export const make = Effect.gen(function* () {
  const agents = yield* AgentMessaging.AgentMessaging;
  return {
    [WS_METHODS.agentsStop]: (input: AgentControlInput) => agents.stop(input),
    [WS_METHODS.agentsResume]: (input: AgentControlInput) => agents.resume(input),
    [WS_METHODS.agentsDiscard]: (input: AgentControlInput) => agents.discard(input),
    [WS_METHODS.subscribeAgentControl]: () => agents.controlChanges,
  };
});
