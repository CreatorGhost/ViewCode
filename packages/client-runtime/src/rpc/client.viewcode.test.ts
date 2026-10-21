import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { subscribe } from "./client.ts";

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return { activeSession, supervisor };
});

// ViewCode: Quick connect's relay closes the socket with 1009 on a message over 1 MiB, and
// resubscribing at once only draws the same close again (and breaks every other request).
it.effect("holds back a subscription whose opening data was too big for the relay", () =>
  Effect.gen(function* () {
    const messageTooBig = new RpcClientError.RpcClientError({
      reason: new Socket.SocketCloseError({
        code: 1009,
        closeReason: `Message too big: ${WS_METHODS.subscribeTerminalEvents}`,
      }),
    });
    const subscriptions: string[] = [];
    const heldBack = yield* Ref.make(0);
    const makeClient = (name: string) =>
      ({
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push(name);
          return name === "second" ? Stream.never : Stream.fail(messageTooBig);
        },
        // Already live when the socket closed: an innocent bystander.
        [WS_METHODS.subscribeServerLifecycle]: () => {
          subscriptions.push(`${name}:lifecycle`);
          return Stream.make({ type: "welcome" }).pipe(
            Stream.concat(name === "first" ? Stream.fail(messageTooBig) : Stream.never),
          );
        },
      }) as unknown as WsRpcProtocolClient;
    const { activeSession, supervisor } = yield* makeHarness();

    const fibers = yield* Effect.all([
      subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        { onMessageTooBig: Ref.update(heldBack, (count) => count + 1) },
      ).pipe(Stream.runDrain, Effect.forkChild),
      subscribe(
        WS_METHODS.subscribeServerLifecycle,
        {},
        { onMessageTooBig: Effect.die("not this one") },
      ).pipe(Stream.runDrain, Effect.forkChild),
    ]).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
    yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient("first"))));
    for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
      yield* Effect.yieldNow;
    }
    // The socket comes back: the bystander resubscribes, the oversized one waits.
    yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient("second"))));
    for (let attempt = 0; attempt < 100 && subscriptions.length < 3; attempt += 1) {
      yield* Effect.yieldNow;
    }
    expect(yield* Ref.get(heldBack)).toBe(1);
    expect(subscriptions).toEqual(["first", "first:lifecycle", "second:lifecycle"]);

    yield* TestClock.adjust("60 seconds");
    for (let attempt = 0; attempt < 100 && subscriptions.length < 4; attempt += 1) {
      yield* Effect.yieldNow;
    }
    expect(subscriptions.at(-1)).toBe("second");
    yield* Effect.forEach(fibers, Fiber.interrupt);
  }),
);
