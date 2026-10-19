import type { DesktopComputerUseCursor } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Wait for the desktop to display the agent's cursor before allowing native input. */
export const makeDesktopCursorBridge = <E>(options: {
  readonly available: boolean;
  readonly send: (message: DesktopComputerUseCursor) => Effect.Effect<void, E>;
}) => Effect.gen(function* () {
  const waiting = new Map<string, Deferred.Deferred<boolean>>();
  yield* Effect.addFinalizer(() => Effect.forEach(waiting.values(), (pending) => Deferred.succeed(pending, false), { discard: true }));
  return {
    acknowledge: (requestId: string, ready: boolean) => {
      const pending = waiting.get(requestId);
      return pending ? Deferred.succeed(pending, ready).pipe(Effect.asVoid) : Effect.void;
    },
    show: (message: DesktopComputerUseCursor) => Effect.gen(function* () {
      if (!options.available) return true;
      const pending = yield* Deferred.make<boolean>();
      waiting.set(message.requestId, pending);
      return yield* options.send(message).pipe(
        Effect.andThen(Deferred.await(pending)),
        Effect.timeoutOption("3 seconds"),
        Effect.map(Option.getOrElse(() => false)),
        Effect.ensuring(Effect.sync(() => { waiting.delete(message.requestId); })),
      );
    }),
  };
});
