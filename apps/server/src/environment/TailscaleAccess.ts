import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  readTailscaleSshEnabled,
  readTailscaleStatus,
  resolveTailscaleBlock,
  TailscaleDisabledError,
  type TailscaleBlockReason,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";

/**
 * How long one `tailscale status` (or `debug prefs`) answer is reused. Each
 * feature use inside this window is served from memory without a spawn.
 */
const TAILSCALE_STATUS_TTL = Duration.seconds(60);

type TailscaleReadError =
  | TailscaleDisabledError
  | TailscaleCommandError
  | TailscaleStatusParseError;

/**
 * ViewCode: the server's only way to run the `tailscale` CLI. Endpoint
 * security on managed Macs kills a process that spawns it, so nothing here runs
 * on startup, a config read or a page load; only a Tailscale feature the user is
 * using calls `status`, `sshEnabled` or `run`. `blockReason` is the gate.
 */
export class TailscaleAccess extends Context.Service<
  TailscaleAccess,
  {
    /** Why Tailscale may not run here, or null when it may. Never spawns. */
    readonly blockReason: Effect.Effect<TailscaleBlockReason | null>;
    /** The last status a feature read, however old. Never spawns. */
    readonly cachedStatus: Effect.Effect<Option.Option<TailscaleStatus>>;
    /** `tailscale status`, spawned at most once per TTL. */
    readonly status: Effect.Effect<TailscaleStatus, TailscaleReadError>;
    /** Whether Tailscale SSH is on (`tailscale debug prefs`), at most once per TTL. */
    readonly sshEnabled: Effect.Effect<boolean, TailscaleReadError>;
    /** Runs another Tailscale command, such as Serve, only while Tailscale is allowed. */
    readonly run: <A, E>(
      command: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ) => Effect.Effect<A, E | TailscaleDisabledError>;
  }
>()("t3/environment/TailscaleAccess") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const env = yield* HostProcess.Environment;
  const lastStatus = yield* Ref.make(Option.none<TailscaleStatus>());

  const blockReason = settings.getSettings.pipe(
    Effect.map((current) => current.tailscaleEnabled),
    // An unreadable settings file must not stop features the user turned on.
    Effect.orElseSucceed(() => true),
    Effect.map((settingEnabled) => resolveTailscaleBlock({ env, settingEnabled })),
  );

  const whenAllowed = <A, E>(
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | TailscaleDisabledError> =>
    Effect.flatMap(blockReason, (reason): Effect.Effect<A, E | TailscaleDisabledError> =>
      reason === null ? effect : Effect.fail(new TailscaleDisabledError({ reason })),
    );

  const withSpawner = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);

  // The gate is checked before the cache, so turning Tailscale off takes effect
  // at once; the cache itself single-flights concurrent callers.
  const readStatusCached = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.tap((status) => Ref.set(lastStatus, Option.some(status))),
      withSpawner,
    ),
    TAILSCALE_STATUS_TTL,
  );
  const readSshEnabledCached = yield* Effect.cachedWithTTL(
    readTailscaleSshEnabled.pipe(withSpawner),
    TAILSCALE_STATUS_TTL,
  );

  return TailscaleAccess.of({
    blockReason,
    cachedStatus: Effect.flatMap(blockReason, (reason) =>
      reason === null ? Ref.get(lastStatus) : Effect.succeedNone,
    ),
    status: whenAllowed(readStatusCached),
    sshEnabled: whenAllowed(readSshEnabledCached),
    run: (command) => whenAllowed(command.pipe(withSpawner)),
  });
});

export const layer = Layer.effect(TailscaleAccess, make);
