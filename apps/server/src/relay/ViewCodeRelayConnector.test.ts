import { describe, expect, it } from "@effect/vitest";
import { HOST_PING_TEXT, HOST_PONG_TEXT } from "@t3tools/shared/viewcodeRelayProtocol";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  followRelayDesire,
  makeRelayStateHolder,
  resolveRelayDesire,
  runRelayConnection,
  runRelaySession,
  type RelayConnectionConfig,
  type RelayDesire,
  type RelayDial,
  type RelayLink,
} from "./ViewCodeRelayConnector.ts";
import { RELAY_REASON, type DialFailure } from "./viewCodeRelayHealth.ts";

const config: RelayConnectionConfig = {
  origin: "https://relay.example.workers.dev",
  hostSecret: "s",
};

/** An in-memory connection: the test decides what arrives and when it ends. */
const makeFakeLink = Effect.gen(function* () {
  const closed = yield* Deferred.make<void>();
  const sent: Array<string | Uint8Array> = [];
  let handler: ((data: string | Uint8Array) => void) | undefined;
  let closedByUs = false;
  const link: RelayLink = {
    send: (data) => {
      sent.push(data);
    },
    onMessage: (next) => {
      handler = next;
    },
    closed: Deferred.await(closed),
    close: Effect.sync(() => {
      closedByUs = true;
    }),
  };
  return {
    link,
    sent,
    pings: () => sent.filter((message) => message === HOST_PING_TEXT).length,
    emit: (data: string | Uint8Array) => handler?.(data),
    drop: Deferred.succeed(closed, undefined),
    closedByUs: () => closedByUs,
  };
});
type FakeLink = Effect.Success<typeof makeFakeLink>;

const makeFakeForwarder = () => {
  const received: Uint8Array[] = [];
  let closeAllCalls = 0;
  return {
    received,
    closeAllCalls: () => closeAllCalls,
    make: () => ({
      receive: (data: Uint8Array) => {
        received.push(data);
      },
      closeAll: () => {
        closeAllCalls += 1;
      },
    }),
  };
};

/** Signals buffered in a queue: a signal sent before anyone waits is not lost. */
const makeSignals = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<void>();
  return {
    stream: Stream.fromQueue(queue),
    send: Queue.offer(queue, undefined).pipe(Effect.asVoid),
  };
});

/** Dial outcomes are scripted; every dial is reported so a test can wait for it. */
const makeScriptedDial = (script: ReadonlyArray<DialFailure | FakeLink>) =>
  Effect.gen(function* () {
    const dials = yield* Queue.unbounded<RelayConnectionConfig>();
    let index = 0;
    const dial: RelayDial = (dialConfig) =>
      Queue.offer(dials, dialConfig).pipe(
        Effect.andThen(() => {
          const outcome = script[Math.min(index, script.length - 1)]!;
          index += 1;
          return "kind" in outcome ? Effect.fail(outcome) : Effect.succeed(outcome.link);
        }),
      );
    return { dial, dials, dialCount: () => index };
  });

const waitForStatus = (holder: Effect.Success<typeof makeRelayStateHolder>, status: string) =>
  SubscriptionRef.changes(holder.state).pipe(
    Stream.filter((state) => state.status === status),
    Stream.runHead,
    Effect.map((state) => (state._tag === "Some" ? state.value : undefined)),
  );

/** No jitter shaved off: every backoff wait is exactly its ceiling. */
const noJitter = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0,
});

/** Lets the connection fiber run until it blocks on its next wait. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 4 }), Effect.asVoid);

const network: DialFailure = { kind: "network", detail: "offline" };
const untrusted: DialFailure = { kind: "tls-untrusted", detail: "SELF_SIGNED_CERT_IN_CHAIN" };

describe("runRelayConnection", () => {
  const setup = (script: ReadonlyArray<DialFailure | FakeLink>) =>
    Effect.gen(function* () {
      const holder = yield* makeRelayStateHolder;
      yield* holder.setConfig({ configured: true, origin: config.origin });
      const signals = yield* makeSignals;
      const scripted = yield* makeScriptedDial(script);
      const forwarder = makeFakeForwarder();
      const fiber = yield* Effect.forkChild(
        runRelayConnection({
          config,
          holder,
          dial: scripted.dial,
          makeForwarder: forwarder.make,
          networkSignals: signals.stream,
        }),
      );
      return { holder, signals, forwarder, fiber, ...scripted };
    });

  /** Nothing dials before `delayMs`, and the next dial happens exactly then. */
  const expectRedialAfter = (
    delayMs: number,
    dials: Queue.Queue<RelayConnectionConfig>,
    dialCount: () => number,
  ) =>
    Effect.gen(function* () {
      const before = dialCount();
      yield* settle;
      yield* TestClock.adjust(Duration.millis(delayMs - 1));
      yield* settle;
      expect(dialCount()).toBe(before);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Queue.take(dials);
      expect(dialCount()).toBe(before + 1);
    });

  it.effect("backs off from 1s doubling to a 30s cap, and reports reconnecting", () =>
    Effect.gen(function* () {
      const { holder, dials, dialCount, fiber } = yield* setup([network]);
      yield* Queue.take(dials);
      expect((yield* waitForStatus(holder, "reconnecting"))?.reason).toBe(RELAY_REASON.network);
      for (const delayMs of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        yield* expectRedialAfter(delayMs, dials, dialCount);
      }
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );

  it.effect("goes blocked after three untrusted-issuer refusals in a row, and recovers", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLink;
      const { holder, dials, dialCount, fiber } = yield* setup([
        untrusted,
        untrusted,
        untrusted,
        fake,
      ]);
      yield* Queue.take(dials);
      expect((yield* waitForStatus(holder, "reconnecting"))?.reason).toBe(
        RELAY_REASON.untrustedRetrying,
      );

      yield* expectRedialAfter(1_000, dials, dialCount);
      yield* settle;
      expect((yield* SubscriptionRef.get(holder.state)).status).toBe("reconnecting");

      yield* expectRedialAfter(2_000, dials, dialCount);
      expect((yield* waitForStatus(holder, "blocked"))?.reason).toBe(RELAY_REASON.untrusted);

      // Blocked keeps trying, slowly, and clears the moment the network lets it through.
      yield* expectRedialAfter(4_000, dials, dialCount);
      const connected = yield* waitForStatus(holder, "connected");
      expect(connected?.reason).toBeUndefined();
      expect(connected?.httpBaseUrl).toBe(config.origin);
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );

  it.effect("does not count other failures towards blocked", () =>
    Effect.gen(function* () {
      const { holder, dials, dialCount, fiber } = yield* setup([
        untrusted,
        untrusted,
        network,
        untrusted,
      ]);
      yield* Queue.take(dials);
      yield* expectRedialAfter(1_000, dials, dialCount);
      yield* expectRedialAfter(2_000, dials, dialCount);
      yield* expectRedialAfter(4_000, dials, dialCount);
      yield* settle;
      expect((yield* SubscriptionRef.get(holder.state)).status).toBe("reconnecting");
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );

  it.effect("stops retrying when the relay refuses the secret", () =>
    Effect.gen(function* () {
      const { holder, signals, dials, dialCount, fiber } = yield* setup([{ kind: "auth" }]);
      yield* Queue.take(dials);
      expect((yield* waitForStatus(holder, "auth-failed"))?.reason).toBe(RELAY_REASON.auth);
      yield* TestClock.adjust(Duration.minutes(5));
      yield* signals.send;
      yield* settle;
      expect(dialCount()).toBe(1);
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects after a drop, waiting out the backoff unless the link was stable", () =>
    Effect.gen(function* () {
      const first = yield* makeFakeLink;
      const second = yield* makeFakeLink;
      const third = yield* makeFakeLink;
      const { holder, forwarder, dials, dialCount, fiber } = yield* setup([first, second, third]);

      yield* Queue.take(dials);
      yield* waitForStatus(holder, "connected");
      // A link that dies straight away waits out the base delay.
      yield* first.drop;
      expect((yield* waitForStatus(holder, "reconnecting"))?.reason).toBe(RELAY_REASON.dropped);
      expect(forwarder.closeAllCalls()).toBe(1);
      expect(first.closedByUs()).toBe(true);
      yield* expectRedialAfter(1_000, dials, dialCount);
      yield* waitForStatus(holder, "connected");

      // A link that held for 30s reconnects at once when it drops.
      yield* TestClock.adjust(Duration.seconds(30));
      yield* second.drop;
      yield* Queue.take(dials);
      expect(dialCount()).toBe(3);
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );

  it.effect("a network change cuts a backoff wait short", () =>
    Effect.gen(function* () {
      const { signals, dials, dialCount, fiber } = yield* setup([network]);
      yield* Queue.take(dials);
      yield* settle;
      // The wait is 1s; the signal ends it without the clock moving.
      yield* signals.send;
      yield* Queue.take(dials);
      expect(dialCount()).toBe(2);
      yield* settle;
      yield* signals.send;
      yield* Queue.take(dials);
      expect(dialCount()).toBe(3);
      yield* Fiber.interrupt(fiber);
    }).pipe(noJitter, Effect.provide(TestClock.layer())),
  );
});

describe("runRelaySession", () => {
  const start = (fake: FakeLink, signals: Stream.Stream<void> = Stream.never) =>
    Effect.gen(function* () {
      const forwarder = makeFakeForwarder();
      const fiber = yield* Effect.forkChild(
        runRelaySession({
          link: fake.link,
          makeForwarder: forwarder.make,
          networkSignals: signals,
        }),
      );
      yield* Effect.yieldNow;
      return { fiber, forwarder };
    });

  it.effect("pings every 20s and ends after two pings go unanswered", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLink;
      const { fiber, forwarder } = yield* start(fake);
      yield* TestClock.adjust(Duration.seconds(20));
      expect(fake.pings()).toBe(1);
      fake.emit(HOST_PONG_TEXT);
      yield* TestClock.adjust(Duration.seconds(20));
      expect(fake.pings()).toBe(2);
      // Unanswered: the next tick counts one missed pong and pings again, the one after gives up.
      yield* TestClock.adjust(Duration.seconds(20));
      expect(fake.pings()).toBe(3);
      yield* TestClock.adjust(Duration.seconds(20));
      expect(yield* Fiber.join(fiber)).toBe(RELAY_REASON.silent);
      expect(forwarder.closeAllCalls()).toBe(1);
      expect(fake.closedByUs()).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("hands binary frames to the forwarder and ends when the socket closes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLink;
      const { fiber, forwarder } = yield* start(fake);
      fake.emit(Uint8Array.of(1, 2, 3));
      expect(forwarder.received).toEqual([Uint8Array.of(1, 2, 3)]);
      yield* fake.drop;
      expect(yield* Fiber.join(fiber)).toBe(RELAY_REASON.dropped);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks a quiet socket right away after a network change", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLink;
      const signals = yield* makeSignals;
      const { fiber } = yield* start(fake, signals.stream);
      yield* signals.send;
      yield* Effect.yieldNow;
      expect(fake.pings()).toBe(1);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(fiber)).toBe(RELAY_REASON.silent);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a socket that answers the network-change check", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLink;
      const signals = yield* makeSignals;
      const { fiber } = yield* start(fake, signals.stream);
      yield* signals.send;
      yield* Effect.yieldNow;
      fake.emit(HOST_PONG_TEXT);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("followRelayDesire", () => {
  it.effect("connects when enabled, restarts on a new secret and disconnects when turned off", () =>
    Effect.gen(function* () {
      const holder = yield* makeRelayStateHolder;
      const desires = yield* Queue.unbounded<RelayDesire>();
      const started = yield* Queue.unbounded<RelayConnectionConfig>();
      const stopped = yield* Queue.unbounded<string>();
      const fiber = yield* Effect.forkChild(
        followRelayDesire({
          desires: Stream.fromQueue(desires),
          holder,
          connect: (next) =>
            Queue.offer(started, next).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Queue.offer(stopped, next.hostSecret)),
            ),
        }),
      );

      yield* Queue.offer(desires, { kind: "unconfigured" });
      expect((yield* waitForStatus(holder, "off"))?.configured).toBe(false);

      yield* Queue.offer(desires, { kind: "enabled", origin: config.origin, hostSecret: "one" });
      expect((yield* Queue.take(started)).hostSecret).toBe("one");

      yield* Queue.offer(desires, { kind: "enabled", origin: config.origin, hostSecret: "two" });
      expect(yield* Queue.take(stopped)).toBe("one");
      expect((yield* Queue.take(started)).hostSecret).toBe("two");

      yield* Queue.offer(desires, { kind: "disabled", origin: config.origin });
      expect(yield* Queue.take(stopped)).toBe("two");
      const off = yield* SubscriptionRef.get(holder.state);
      expect(off).toMatchObject({ status: "off", configured: true, httpBaseUrl: config.origin });
      yield* Fiber.interrupt(fiber);
    }),
  );
});

describe("resolveRelayDesire", () => {
  const settings = (enabled: boolean, url?: string) => ({ viewcodeRelay: { enabled, url } });

  it("needs an https origin and a secret before anything can run", () => {
    expect(resolveRelayDesire(settings(true), "secret")).toEqual({ kind: "unconfigured" });
    expect(resolveRelayDesire(settings(true, "http://relay.example"), "secret")).toEqual({
      kind: "unconfigured",
    });
    expect(resolveRelayDesire(settings(true, "https://relay.example.workers.dev"), null)).toEqual({
      kind: "unconfigured",
    });
    expect(resolveRelayDesire(settings(true, "https://relay.example.workers.dev"), "")).toEqual({
      kind: "unconfigured",
    });
  });

  it("keeps the origin when the switch is off and only the origin when enabled", () => {
    expect(
      resolveRelayDesire(settings(false, "https://relay.example.workers.dev/x"), "secret"),
    ).toEqual({
      kind: "disabled",
      origin: "https://relay.example.workers.dev",
    });
    expect(
      resolveRelayDesire(settings(true, "https://relay.example.workers.dev"), "secret"),
    ).toEqual({
      kind: "enabled",
      origin: "https://relay.example.workers.dev",
      hostSecret: "secret",
    });
  });
});
