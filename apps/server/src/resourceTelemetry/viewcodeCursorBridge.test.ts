import { assert, it } from "@effect/vitest";
import type { DesktopComputerUseCursor } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeDesktopCursorBridge } from "./viewcodeCursorBridge.ts";

const cursor: DesktopComputerUseCursor = {
  version: 1,
  type: "computerUseCursor",
  requestId: "cursor-1",
  threadId: "thread-1",
  threadName: "Test",
  windowHandle: "window-1",
  x: 20,
  y: 30,
  action: "click",
};

it.effect(
  "matches acknowledgements and refuses input when the desktop refuses cursor arrival",
  () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<boolean>();
      const bridge = yield* makeDesktopCursorBridge({
        available: true,
        send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
      });
      const show = yield* bridge.show(cursor).pipe(
        Effect.tap((ready) => Deferred.succeed(completed, ready)),
        Effect.forkScoped,
      );
      yield* Deferred.await(sent);
      yield* bridge.acknowledge("another-cursor", true);
      assert.isFalse(yield* Deferred.isDone(completed));
      yield* bridge.acknowledge(cursor.requestId, false);
      assert.isFalse(yield* Fiber.join(show));
    }),
);

it.effect("fails closed when the desktop never acknowledges", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    const bridge = yield* makeDesktopCursorBridge({
      available: true,
      send: () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
    });
    const show = yield* bridge.show(cursor).pipe(Effect.forkScoped);
    yield* Deferred.await(sent);
    yield* TestClock.adjust("3 seconds");
    assert.isFalse(yield* Fiber.join(show));
  }),
);
