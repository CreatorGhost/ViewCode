import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUse from "../computerUse/ComputerUseService.ts";

export const make = Effect.gen(function* () {
  const computer = yield* ComputerUse.ComputerUseService;
  return {
    [WS_METHODS.serverGetComputerUseStatus]: () => computer.status,
    [WS_METHODS.serverGetComputerUseActivity]: () =>
      computer.recentActivity.pipe(Effect.map((entries) => ({ entries }))),
  };
});
