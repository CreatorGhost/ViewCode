import type { DesktopComputerUseCursor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DesktopTelemetryReceiver } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/** Tests and headless hosts have no panel. The live desktop acknowledges arrival before input. */
export const ComputerUseCursor = Context.Reference<
  (message: DesktopComputerUseCursor) => Effect.Effect<boolean>
>("t3/computerUse/ComputerUseCursor", { defaultValue: () => () => Effect.succeed(true) });

export const layer = Layer.effect(
  ComputerUseCursor,
  Effect.gen(function* () {
    const desktop = yield* DesktopTelemetryReceiver;
    return (message: DesktopComputerUseCursor) =>
      desktop.showComputerUseCursor(message).pipe(Effect.orElseSucceed(() => false));
  }),
);
