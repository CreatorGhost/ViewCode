import { WS_METHODS, type RockBotOpenInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RockBotService from "../rockbot/RockBotService.ts";

export const make = Effect.gen(function* () {
  const rockbot = yield* RockBotService.RockBotService;
  return {
    [WS_METHODS.rockbotOpen]: (input: RockBotOpenInput) => rockbot.open(input),
  };
});
