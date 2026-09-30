/**
 * ViewCode Quick connect: the server's outbound connection to the user's own
 * relay Worker (`infra/viewcode-relay`). One WebSocket over wss/443, opened
 * from this side, so it works where inbound ports and tunnels do not. The
 * phone reaches this computer through the Worker; requests the Worker
 * forwards are served by `relayForwarder.ts` against the server's own HTTP
 * handling.
 *
 * Status (`ViewCodeRelayState`) is honest about what the network does: an
 * untrusted TLS issuer several times in a row is `blocked`, a refused secret
 * is `auth-failed` (retrying cannot fix it), everything else keeps trying
 * with jittered backoff from 1s to 30s. Nothing polls; a resume from sleep
 * cuts a backoff wait short.
 */
import type { ServerSettings as ServerSettingsShape, ViewCodeRelayState } from "@t3tools/contracts";
import {
  HOST_MAX_MISSED_PONGS,
  HOST_PING_INTERVAL_MS,
  HOST_PING_TEXT,
  HOST_PONG_TEXT,
  RELAY_HOST_PATH,
  RELAY_HOST_SECRET_NAME,
} from "@t3tools/shared/viewcodeRelayProtocol";
import * as Undici from "@effect/platform-node/Undici";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { normalizeTunnelHttpBaseUrl } from "../cloud/config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createRelayForwarder, type RelayForwarder } from "./relayForwarder.ts";
import {
  classifyDialError,
  type DialFailure,
  describeErrorChain,
  initialRelayHealth,
  type LocalTarget,
  reconnectDelayMs,
  RELAY_REASON,
  reduceRelayHealth,
  type RelayHealth,
  type RelayHealthEvent,
  STABLE_CONNECTION_MS,
  toViewCodeRelayState,
} from "./viewCodeRelayHealth.ts";

/** How long a probe ping waits for its pong after a network change. */
const PROBE_PONG_WAIT = Duration.seconds(10);

export interface RelayConnectionConfig {
  /** The relay's https origin, as stored. */
  readonly origin: string;
  readonly hostSecret: string;
}

/** What the connector should do, decided from settings and the secret store. */
export type RelayDesire =
  | { readonly kind: "unconfigured" }
  | { readonly kind: "disabled"; readonly origin: string }
  | { readonly kind: "enabled"; readonly origin: string; readonly hostSecret: string };

/** One open connection to the relay, whatever carries it. */
export interface RelayLink {
  readonly send: (data: string | Uint8Array) => void;
  readonly onMessage: (handler: (data: string | Uint8Array) => void) => void;
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

export type RelayDial = (config: RelayConnectionConfig) => Effect.Effect<RelayLink, DialFailure>;

// --- session: one open connection ----------------------------------------------

/**
 * Serves one open connection until it ends, and returns why (a phrase for the
 * person). Ends on: the socket closing, `HOST_MAX_MISSED_PONGS` pings without
 * an answer, or a network-change probe that finds the socket dead.
 */
export const runRelaySession = (input: {
  readonly link: RelayLink;
  readonly makeForwarder: (send: (frame: Uint8Array) => void) => RelayForwarder;
  readonly networkSignals: Stream.Stream<void>;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    const { link } = input;
    const forwarder = input.makeForwarder((frame) => link.send(frame));
    let pingOutstanding = false;
    let missed = 0;
    link.onMessage((message) => {
      if (typeof message === "string") {
        if (message === HOST_PONG_TEXT) {
          pingOutstanding = false;
          missed = 0;
        }
        return;
      }
      forwarder.receive(message);
    });

    const closed = link.closed.pipe(Effect.as(RELAY_REASON.dropped));
    const pings = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(Duration.millis(HOST_PING_INTERVAL_MS));
        if (pingOutstanding) missed += 1;
        if (missed >= HOST_MAX_MISSED_PONGS) return RELAY_REASON.silent;
        pingOutstanding = true;
        link.send(HOST_PING_TEXT);
      }
    });
    // A resume or network change may have killed the socket without a close
    // event: ask now and give it a short deadline, instead of waiting for pings.
    const probes = input.networkSignals.pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          pingOutstanding = true;
          link.send(HOST_PING_TEXT);
          yield* Effect.sleep(PROBE_PONG_WAIT);
          return pingOutstanding ? Option.some(RELAY_REASON.silent) : Option.none<string>();
        }),
      ),
      Stream.filterMap((reason) =>
        Option.isSome(reason) ? Result.succeed(reason.value) : Result.failVoid,
      ),
      Stream.runHead,
      Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
    );

    return yield* Effect.raceAll([closed, pings, probes]).pipe(
      Effect.ensuring(Effect.sync(() => forwarder.closeAll()).pipe(Effect.andThen(link.close))),
    );
  });

// --- connection loop ----------------------------------------------------------------

export interface RelayStateHolder {
  readonly state: SubscriptionRef.SubscriptionRef<ViewCodeRelayState>;
  /** Applies a health event and publishes the result. */
  readonly apply: (event: RelayHealthEvent) => Effect.Effect<void>;
  /** Records what is configured; resets health to off. */
  readonly setConfig: (config: {
    readonly configured: boolean;
    readonly origin: string | undefined;
  }) => Effect.Effect<void>;
}

export const makeRelayStateHolder = Effect.gen(function* () {
  const health = yield* Ref.make<RelayHealth>(initialRelayHealth);
  const configRef = yield* Ref.make<{ configured: boolean; origin: string | undefined }>({
    configured: false,
    origin: undefined,
  });
  const state = yield* SubscriptionRef.make<ViewCodeRelayState>(
    toViewCodeRelayState(initialRelayHealth, { configured: false, origin: undefined }),
  );
  const publish = Effect.gen(function* () {
    const next = toViewCodeRelayState(yield* Ref.get(health), yield* Ref.get(configRef));
    yield* SubscriptionRef.update(state, (current) =>
      current.status === next.status &&
      current.configured === next.configured &&
      current.reason === next.reason &&
      current.httpBaseUrl === next.httpBaseUrl
        ? current
        : next,
    );
  });
  const holder: RelayStateHolder = {
    state,
    apply: (event) =>
      Ref.update(health, (current) => reduceRelayHealth(current, event)).pipe(
        Effect.andThen(publish),
      ),
    setConfig: (config) =>
      Ref.set(configRef, { ...config }).pipe(
        Effect.andThen(Ref.set(health, initialRelayHealth)),
        Effect.andThen(publish),
      ),
  };
  return holder;
});

/**
 * Keeps one connection to the relay alive until interrupted: dial, serve, and
 * on any end wait out a jittered backoff (1s doubling to 30s; reset after a
 * connection that held for 30s) before dialing again. A network signal cuts
 * the wait short. A refused secret stops retrying: only a new config helps,
 * and the caller restarts this loop when the config changes.
 */
export const runRelayConnection = (input: {
  readonly config: RelayConnectionConfig;
  readonly holder: RelayStateHolder;
  readonly dial: RelayDial;
  readonly makeForwarder: (send: (frame: Uint8Array) => void) => RelayForwarder;
  readonly networkSignals: Stream.Stream<void>;
}): Effect.Effect<never> =>
  Effect.gen(function* () {
    const { holder } = input;
    let attempt = 0;
    const backoff = Effect.gen(function* () {
      const delay = reconnectDelayMs(attempt, yield* Random.next);
      attempt += 1;
      yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(delay)),
        input.networkSignals.pipe(Stream.take(1), Stream.runDrain),
      );
    });
    for (;;) {
      yield* holder.apply({ type: "attempt" });
      const dialed = yield* Effect.result(input.dial(input.config));
      if (Result.isFailure(dialed)) {
        yield* holder.apply({ type: "dial-failed", failure: dialed.failure });
        if (dialed.failure.kind === "auth") return yield* Effect.never;
        yield* backoff;
        continue;
      }
      yield* holder.apply({ type: "connected" });
      const startedAt = yield* Clock.currentTimeMillis;
      const reason = yield* runRelaySession({
        link: dialed.success,
        makeForwarder: input.makeForwarder,
        networkSignals: input.networkSignals,
      });
      yield* holder.apply({ type: "dropped", reason });
      if ((yield* Clock.currentTimeMillis) - startedAt >= STABLE_CONNECTION_MS) {
        attempt = 0;
      } else {
        yield* backoff;
      }
    }
  });

/**
 * Follows the desired configuration: each change interrupts the running
 * connection and starts what the new config asks for (nothing, when it is off
 * or not set up).
 */
export const followRelayDesire = (input: {
  readonly desires: Stream.Stream<RelayDesire>;
  readonly holder: RelayStateHolder;
  readonly connect: (config: RelayConnectionConfig) => Effect.Effect<never>;
}): Effect.Effect<void> =>
  input.desires.pipe(
    Stream.switchMap((desire) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          if (desire.kind === "unconfigured") {
            yield* input.holder.setConfig({ configured: false, origin: undefined });
            return yield* Effect.never;
          }
          yield* input.holder.setConfig({ configured: true, origin: desire.origin });
          if (desire.kind === "disabled") return yield* Effect.never;
          return yield* input.connect({ origin: desire.origin, hostSecret: desire.hostSecret });
        }),
      ),
    ),
    Stream.runDrain,
  );

// --- real connection to the Worker -------------------------------------------------

/** Stored origins are always https; plain http exists so tests can talk to a local workerd. */
export const relayHostUrl = (origin: string): string => {
  const url = new URL(origin);
  return `${url.protocol === "http:" ? "ws" : "wss"}://${url.host}${RELAY_HOST_PATH}`;
};

const openRelaySocket = (config: RelayConnectionConfig) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    return yield* Effect.callback<RelayLink, string>((resume) => {
      let socket: InstanceType<typeof Undici.WebSocket>;
      try {
        socket = new Undici.WebSocket(relayHostUrl(config.origin), {
          headers: { authorization: `Bearer ${config.hostSecret}` },
        });
      } catch (cause) {
        resume(Effect.fail(describeErrorChain(cause)));
        return;
      }
      socket.binaryType = "arraybuffer";
      let handler: ((data: string | Uint8Array) => void) | undefined;
      const end = () => {
        Deferred.doneUnsafe(closed, Effect.void);
      };
      socket.addEventListener("open", () =>
        resume(
          Effect.succeed({
            send: (data) => {
              try {
                socket.send(data);
              } catch {
                // The socket is closing; `closed` follows.
              }
            },
            onMessage: (next) => {
              handler = next;
            },
            closed: Deferred.await(closed),
            close: Effect.sync(() => {
              try {
                socket.close(1000);
              } catch {
                // Already closed.
              }
            }),
          }),
        ),
      );
      socket.addEventListener("message", (event) => {
        handler?.(
          typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
        );
      });
      socket.addEventListener("error", (event) => {
        // Before open this is the dial failing; after, `close` follows.
        resume(
          Effect.fail(describeErrorChain((event as { readonly error?: unknown }).error ?? event)),
        );
        end();
      });
      socket.addEventListener("close", () => {
        resume(Effect.fail("closed before it opened"));
        end();
      });
      return Effect.sync(() => {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      });
    });
  });

/**
 * After a failed WebSocket dial, one plain HTTPS request tells the causes
 * apart: the browser-style WebSocket error is opaque, but a 401 means the
 * secret is wrong, and a fetch error still carries the certificate code.
 */
const probeRelayFailure = (
  config: RelayConnectionConfig,
  dialError: string,
): Effect.Effect<DialFailure> => {
  const early = classifyDialError(dialError);
  if (early.kind === "tls-untrusted") return Effect.succeed(early);
  return Effect.tryPromise({
    try: (signal) =>
      Undici.fetch(`${config.origin}${RELAY_HOST_PATH}`, {
        headers: { authorization: `Bearer ${config.hostSecret}` },
        redirect: "manual",
        signal,
      }),
    catch: (cause) => describeErrorChain(cause),
  }).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.match({
      onFailure: (cause): DialFailure => classifyDialError(describeErrorChain(cause)),
      onSuccess: (response): DialFailure => {
        void response.body?.cancel().catch(() => undefined);
        return response.status === 401
          ? { kind: "auth" }
          : { kind: "network", detail: `The relay answered ${response.status}.` };
      },
    }),
  );
};

export const dialRelay: RelayDial = (config) =>
  openRelaySocket(config).pipe(
    Effect.catch((dialError) => probeRelayFailure(config, dialError).pipe(Effect.flip)),
  );

// --- service ----------------------------------------------------------------------------

export class ViewCodeRelayConnector extends Context.Service<
  ViewCodeRelayConnector,
  {
    /** The current state, then every change. */
    readonly stateChanges: Stream.Stream<ViewCodeRelayState>;
    readonly currentState: Effect.Effect<ViewCodeRelayState>;
    /** A resume from sleep or a network change: reconnect now instead of waiting. */
    readonly networkChanged: Effect.Effect<void>;
    /** Runs until interrupted; call once the server is listening and active. */
    readonly run: (target: LocalTarget) => Effect.Effect<void>;
  }
>()("t3/relay/ViewCodeRelayConnector") {}

const decodeSecret = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

export const resolveRelayDesire = (
  settings: {
    readonly viewcodeRelay: { readonly enabled: boolean; readonly url?: string | undefined };
  },
  hostSecret: string | null,
): RelayDesire => {
  const origin = normalizeTunnelHttpBaseUrl(settings.viewcodeRelay.url);
  if (origin === null || hostSecret === null || hostSecret === "") return { kind: "unconfigured" };
  return settings.viewcodeRelay.enabled
    ? { kind: "enabled", origin, hostSecret }
    : { kind: "disabled", origin };
};

export const layer = Layer.effect(
  ViewCodeRelayConnector,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const holder = yield* makeRelayStateHolder;
    const signals = yield* PubSub.sliding<void>(1);

    const readDesire = (current: ServerSettingsShape) =>
      secrets.get(RELAY_HOST_SECRET_NAME).pipe(
        Effect.map((bytes) => (Option.isSome(bytes) ? decodeSecret(bytes.value) : null)),
        Effect.orElseSucceed(() => null),
        Effect.map((secret) => resolveRelayDesire(current, secret)),
      );

    return ViewCodeRelayConnector.of({
      stateChanges: SubscriptionRef.changes(holder.state),
      currentState: SubscriptionRef.get(holder.state),
      networkChanged: PubSub.publish(signals, undefined).pipe(Effect.asVoid),
      run: (target) =>
        Effect.gen(function* () {
          const changes = yield* settings.subscribeChanges;
          const initial = yield* settings.getSettings.pipe(Effect.orDie);
          const desires = Stream.concat(Stream.make(initial), changes).pipe(
            Stream.mapEffect(readDesire),
            Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
          );
          yield* followRelayDesire({
            desires,
            holder,
            connect: (config) =>
              runRelayConnection({
                config,
                holder,
                dial: dialRelay,
                makeForwarder: (send) => createRelayForwarder({ target, send }),
                networkSignals: Stream.fromPubSub(signals),
              }),
          });
        }).pipe(Effect.scoped),
    });
  }),
);

const unconfiguredState: ViewCodeRelayState = { status: "off", configured: false };

/** For tests that stand in for the connector without a relay. */
export const layerUnconfigured = Layer.succeed(
  ViewCodeRelayConnector,
  ViewCodeRelayConnector.of({
    stateChanges: Stream.make(unconfiguredState),
    currentState: Effect.succeed(unconfiguredState),
    networkChanged: Effect.void,
    run: () => Effect.void,
  }),
);
