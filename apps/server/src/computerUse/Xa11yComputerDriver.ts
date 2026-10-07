// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - owns a child process and its IPC timeouts at callback boundaries.
/**
 * `ComputerDriver` backed by xa11y running in a separate driver process.
 *
 * Why a child process: the native module can crash or hang inside the OS
 * accessibility API (a misbehaving app is enough), and that must not take
 * the server down. Why `process.execPath` + `ELECTRON_RUN_AS_NODE=1`: on
 * macOS the child then runs as the app itself and shares its Accessibility
 * and Screen Recording grants, the same trick desktop's
 * `SnapShotAccessibilityProcess` uses.
 *
 * Calls are serialized. A worker that dies or times out is killed and
 * restarted on the next call; its handles die with it, which the service
 * sees as `stale`. Every reply is decoded; anything else is `malformed`,
 * never a partial success. The worker asks the server's dispatch check
 * before it prepares a target and again before native input (see
 * `ComputerDriverDispatchCheck`). A crash, timeout or malformed reply after
 * an allowed `dispatch` reports `dispatched: "unknown"`; before one,
 * nothing was sent.
 *
 * A call interrupted while still queued is never sent. Once sent, the
 * interruption waits for the worker's reply: a pending dispatch check is
 * refused, but input already allowed may be landing, and the dispatch lock
 * stays held until it returns.
 *
 * The worker is recycled after `recycleAfter` requests (xa11y's macOS
 * element cache never shrinks); old handles then read as stale, with a
 * message saying the driver restarted (each worker gets a fresh epoch). If a
 * worker died during a click or drag, its replacement first releases the
 * left mouse button, which may still be held.
 *
 * Worker starts, stops (with the reason) and per-op timeouts are logged at
 * INFO with pids, epochs, op names and timeouts only, never request contents.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import { ComputerUseErrorCode, ComputerUseRect, type ComputerUseError } from "@t3tools/contracts";
import { HostProcessIsExecutable, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  ComputerDriver,
  ComputerDriverError,
  ComputerDriverDispatchCheck,
  type DriverDispatchDecision,
  type DriverDispatchPhase,
  type DriverDispatchTarget,
  type ComputerDriverShape,
  type DriverStatus,
} from "./ComputerDriver.ts";
import {
  ACTIVATION_TIMEOUT_MS,
  DRIVER_EPOCH_ENV,
  DRIVER_NONCE_ENV,
  type DriverOp,
  type DriverRequest,
} from "./Xa11yDriverCore.ts";

export interface DriverWorkerLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export interface Xa11yComputerDriverOptions {
  readonly platform: NodeJS.Platform;
  /** Resolved on first use, so an unused driver costs nothing. */
  readonly launch: () => DriverWorkerLaunch;
  readonly timeouts?: Partial<Record<DriverOp, number>>;
  /** Requests one worker serves before it is replaced. */
  readonly recycleAfter?: number;
}

const DEFAULT_RECYCLE_AFTER = 500;
/** Ops that press a mouse button and could leave it held if the worker dies mid-call. */
const MOUSE_BUTTON_OPS: ReadonlySet<DriverOp> = new Set(["click", "drag"]);

/**
 * Input may resolve its element, activate the window (up to
 * `ACTIVATION_TIMEOUT_MS`), name a coordinate target (a walk of up to 3 s)
 * and, for an accessibility action the app does not support, activate again
 * for the fallback, all before the input itself.
 */
const INPUT_TIMEOUT_MS = 2 * ACTIVATION_TIMEOUT_MS + 14_000;
/** Typing long text adds its own time on top. */
const TYPING_TIMEOUT_MS = INPUT_TIMEOUT_MS + 10_000;

const DEFAULT_TIMEOUTS: Record<DriverOp, number> = {
  status: 10_000,
  releaseMouse: 5_000,
  listWindows: 10_000,
  observe: 15_000,
  screenshot: 30_000,
  elementAt: 8_000,
  press: INPUT_TIMEOUT_MS,
  setValue: INPUT_TIMEOUT_MS,
  typeText: TYPING_TIMEOUT_MS,
  key: INPUT_TIMEOUT_MS,
  scroll: INPUT_TIMEOUT_MS,
  click: INPUT_TIMEOUT_MS,
  drag: INPUT_TIMEOUT_MS,
  move: INPUT_TIMEOUT_MS,
  scrollAt: INPUT_TIMEOUT_MS,
  typeFocused: TYPING_TIMEOUT_MS,
};

const INPUT_OPS: ReadonlySet<DriverOp> = new Set([
  "press",
  "setValue",
  "typeText",
  "key",
  "scroll",
  "click",
  "drag",
  "move",
  "scrollAt",
  "typeFocused",
]);
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);

const unsupportedReason = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? "Computer use is not supported on Windows yet."
    : "Computer use is not supported on this platform.";

const DriverFailure = Schema.Struct({
  kind: Schema.Literals([
    "policy",
    "unavailable",
    "permission-accessibility",
    "permission-screen",
    "stale",
    "failed",
    "timeout",
    "malformed",
  ]),
  message: Schema.String,
  dispatched: Schema.Literals(["no", "yes", "unknown"]),
  code: Schema.optionalKey(ComputerUseErrorCode),
  reason: Schema.optionalKey(Schema.Literal("restarted")),
});

const DriverDiagnostics = Schema.Struct({
  windowEnumerationFailures: Schema.Int.check(Schema.isGreaterThan(0)),
});

type DriverReply<T> =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: T;
      readonly diagnostics?: typeof DriverDiagnostics.Type;
    }
  | { readonly id: number; readonly ok: false; readonly error: typeof DriverFailure.Type };

const replyOf = <S extends Schema.Top>(result: S) =>
  Schema.Union([
    Schema.Struct({
      id: Schema.Number,
      ok: Schema.Literal(true),
      result,
      diagnostics: Schema.optionalKey(DriverDiagnostics),
    }),
    Schema.Struct({ id: Schema.Number, ok: Schema.Literal(false), error: DriverFailure }),
  ]);

const StatusReply = replyOf(
  Schema.Struct({
    available: Schema.Boolean,
    accessibility: Schema.Literals(["granted", "denied", "unknown"]),
    reason: Schema.optionalKey(Schema.String),
  }),
);
const WindowsReply = replyOf(
  Schema.Array(
    Schema.Struct({
      handle: Schema.String,
      app: Schema.String,
      pid: Schema.Int,
      title: Schema.String,
      focused: Schema.Boolean,
      bounds: Schema.optionalKey(ComputerUseRect),
      appIdentifier: Schema.optionalKey(Schema.String),
    }),
  ),
);
const ObserveReply = replyOf(
  Schema.Struct({
    elements: Schema.Array(
      Schema.Struct({
        handle: Schema.String,
        role: Schema.String,
        label: Schema.String,
        value: Schema.optionalKey(Schema.String),
        enabled: Schema.Boolean,
        focused: Schema.Boolean,
      }),
    ),
    truncated: Schema.Boolean,
  }),
);
const ScreenshotReply = replyOf(
  Schema.Struct({
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    bounds: ComputerUseRect,
  }),
);
const ElementAtReply = replyOf(
  Schema.NullOr(Schema.Struct({ role: Schema.String, label: Schema.String })),
);
const InputReply = replyOf(Schema.Struct({ tookFocus: Schema.Boolean }));

type WorkerOutcome =
  | { readonly type: "reply"; readonly message: unknown }
  /** The request never reached a worker. */
  | { readonly type: "not-sent" }
  /** The caller gave up while the request was still queued; it was never sent. */
  | { readonly type: "cancelled" }
  | { readonly type: "exited" }
  | { readonly type: "timeout" };

/** `authorized`: an allowed `dispatch` decision went to the worker, so input may have run. */
type CallOutcome = WorkerOutcome & { readonly authorized: boolean };

type Authorize = (
  target: DriverDispatchTarget,
  phase: DriverDispatchPhase,
) => Promise<DriverDispatchDecision>;

const releaseNow = (decision: DriverDispatchDecision) => {
  if (decision.allowed) Effect.runSync(decision.release);
};

const CANCELLED_BEFORE_DISPATCH: ComputerUseError = {
  code: "CU-CON-004",
  message: "The action was cancelled before dispatch.",
  effect: "not-dispatched",
};

const isReplyTo = (message: unknown, id: number): boolean =>
  typeof message === "object" && message !== null && "id" in message && message.id === id;

/** Why a worker went away; `crash` is any exit or channel loss we did not cause. */
type StopReason = "timeout" | "crash" | "recycle" | "malformed";

/** Lifecycle lines; fields carry pids, epochs, ops and numbers only. */
type WorkerLog = (message: string, fields: Record<string, unknown>) => void;

/** Plain child-process client; the Effect surface wraps it below. */
const makeWorkerClient = (options: Xa11yComputerDriverOptions, log: WorkerLog) => {
  let child: NodeChildProcess.ChildProcess | undefined;
  let nonce = "";
  let served = 0;
  let releaseMouse = false;
  let nextId = 1;
  let settlePending: ((outcome: WorkerOutcome) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const workerEpochs = new WeakMap<NodeChildProcess.ChildProcess, string>();

  /**
   * Kills a worker and stops listening to it, so it is reported once. A
   * `reason` logs the stop; shutdown and failed spawns pass none.
   */
  const discard = (
    worker: NodeChildProcess.ChildProcess,
    reason?: StopReason,
    exit?: { readonly code: number | null; readonly signal: NodeJS.Signals | null },
  ) => {
    if (child === worker) child = undefined;
    worker.removeAllListeners();
    worker.on("error", () => undefined);
    worker.kill("SIGKILL");
    if (reason) {
      log("computer-use driver stopped", {
        pid: worker.pid,
        epoch: workerEpochs.get(worker),
        reason,
        ...(exit ? { code: exit.code, signal: exit.signal } : {}),
      });
    }
  };

  const start = (): NodeChildProcess.ChildProcess | undefined => {
    const launch = options.launch();
    nonce = NodeCrypto.randomBytes(32).toString("hex");
    const epoch = NodeCrypto.randomBytes(4).toString("hex");
    served = 0;
    let worker: NodeChildProcess.ChildProcess;
    try {
      worker = NodeChildProcess.spawn(launch.command, [...launch.args], {
        env: { ...launch.env, [DRIVER_NONCE_ENV]: nonce, [DRIVER_EPOCH_ENV]: epoch },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        windowsHide: true,
      });
    } catch {
      log("computer-use driver could not start", {});
      return undefined;
    }
    workerEpochs.set(worker, epoch);
    // `pid` is unset only when the spawn itself failed.
    if (worker.pid === undefined) log("computer-use driver could not start", {});
    else log("computer-use driver started", { pid: worker.pid, epoch });
    worker.on("message", (message) => settlePending?.({ type: "reply", message }));
    worker.once("error", () => {
      const spawned = worker.pid !== undefined;
      discard(worker, spawned ? "crash" : undefined);
      settlePending?.(spawned ? { type: "exited" } : { type: "not-sent" });
    });
    worker.once("exit", (code, signal) => {
      discard(worker, "crash", { code, signal });
      settlePending?.({ type: "exited" });
    });
    return worker;
  };

  const run = (request: DriverRequest, authorize?: Authorize): Promise<CallOutcome> =>
    new Promise((done) => {
      let authorized = false;
      // The dispatch lock behind the last allowed `dispatch`: held until the
      // worker's next message, which it sends only once that input returned.
      let held: DriverDispatchDecision | undefined;
      const releaseHeld = () => {
        const decision = held;
        held = undefined;
        if (decision) releaseNow(decision);
      };
      const resolve = (outcome: WorkerOutcome) => done({ ...outcome, authorized });
      if (closed) return resolve({ type: "not-sent" });
      child ??= start();
      const worker = child;
      if (!worker?.connected) {
        if (worker) discard(worker, worker.pid === undefined ? undefined : "crash");
        return resolve({ type: "not-sent" });
      }
      const id = nextId++;
      const timeoutMs = options.timeouts?.[request.op] ?? DEFAULT_TIMEOUTS[request.op];
      const timeout = setTimeout(() => {
        log("computer-use driver call timed out", { op: request.op, timeoutMs });
        discard(worker, "timeout");
        settle({ type: "timeout" });
      }, timeoutMs);
      const settle = (outcome: WorkerOutcome) => {
        if (settlePending !== settle) return;
        releaseHeld();
        if (
          outcome.type === "reply" &&
          isReplyTo(outcome.message, id) &&
          typeof outcome.message === "object" &&
          outcome.message !== null &&
          "authorize" in outcome.message
        ) {
          const target = outcome.message.authorize as DriverDispatchTarget;
          const phase: DriverDispatchPhase =
            "phase" in outcome.message && outcome.message.phase === "prepare"
              ? "prepare"
              : "dispatch";
          void (
            authorize
              ? authorize(target, phase)
              : Promise.resolve<DriverDispatchDecision>({
                  allowed: false,
                  error: CANCELLED_BEFORE_DISPATCH,
                })
          ).then(
            (decision) => {
              if (settlePending !== settle) return releaseNow(decision);
              if (decision.allowed && phase === "dispatch") {
                held = decision;
                authorized = true;
              } else {
                releaseNow(decision);
              }
              worker.send(
                { id, nonce, decision: decision.allowed ? null : decision.error },
                (error) => {
                  if (error) {
                    discard(worker, "crash");
                    settle({ type: "exited" });
                  }
                },
              );
            },
            () => {
              discard(worker, "crash");
              settle({ type: "exited" });
            },
          );
          return;
        }
        settlePending = undefined;
        clearTimeout(timeout);
        // A reply that does not answer this request means the channel is out
        // of step: answer malformed and start over rather than misattribute.
        if (outcome.type === "reply" && !isReplyTo(outcome.message, id)) {
          discard(worker, "malformed");
          resolve({ type: "reply", message: undefined });
          return;
        }
        if (outcome.type !== "reply" && authorized && MOUSE_BUTTON_OPS.has(request.op)) {
          releaseMouse = true;
        }
        served += 1;
        if (served >= (options.recycleAfter ?? DEFAULT_RECYCLE_AFTER)) discard(worker, "recycle");
        resolve(outcome);
      };
      settlePending = settle;
      try {
        worker.send({ id, nonce, request }, (error) => {
          if (error) {
            discard(worker, "crash");
            settle({ type: "not-sent" });
          }
        });
      } catch {
        discard(worker, "crash");
        settle({ type: "not-sent" });
      }
    });

  return {
    /** `inFlight` settles at once for a request not yet sent, else with its reply. */
    call: (request: DriverRequest, cancelled: () => boolean, authorize: Authorize) => {
      let sent = false;
      const result = queue.then(async (): Promise<CallOutcome> => {
        if (cancelled()) return { type: "cancelled", authorized: false };
        if (releaseMouse) {
          releaseMouse = false;
          await run({ op: "releaseMouse" });
        }
        if (cancelled()) return { type: "cancelled", authorized: false };
        sent = true;
        return run(request, authorize);
      });
      queue = result;
      return {
        result,
        inFlight: (): Promise<void> => (sent ? result.then(() => undefined) : Promise.resolve()),
      };
    },
    close: () => {
      closed = true;
      if (child) discard(child);
      settlePending?.({ type: "exited" });
    },
  };
};

export const makeXa11yComputerDriver = Effect.fnUntraced(function* (
  options: Xa11yComputerDriverOptions,
) {
  const logContext = yield* Effect.context();
  const client = makeWorkerClient(options, (message, fields) =>
    Effect.runSyncWith(logContext)(Effect.logInfo(message, fields)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(client.close));

  const call = Effect.fnUntraced(function* <T>(
    request: DriverRequest,
    reply: Schema.Decoder<DriverReply<T>>,
  ) {
    const input = INPUT_OPS.has(request.op);
    if (!SUPPORTED_PLATFORMS.has(options.platform)) {
      return yield* new ComputerDriverError({
        kind: "unavailable",
        message: unsupportedReason(options.platform),
        dispatched: "no",
      });
    }
    const check = yield* ComputerDriverDispatchCheck;
    const context = yield* Effect.context();
    const outcome = yield* Effect.callback<CallOutcome>((resume, signal) => {
      // Interrupting the caller marks a queued request so it is never sent,
      // and refuses a dispatch check still to come.
      const pending = client.call(
        request,
        () => signal.aborted,
        async (target, phase) => {
          const cancelled: DriverDispatchDecision = {
            allowed: false,
            error: CANCELLED_BEFORE_DISPATCH,
          };
          if (signal.aborted) return cancelled;
          const decision = await Effect.runPromiseWith(context)(check(target, phase));
          if (!signal.aborted) return decision;
          releaseNow(decision);
          return cancelled;
        },
      );
      void pending.result.then((value) => resume(Effect.succeed(value)));
      // A sent request may already be delivering input: wait for its reply.
      return Effect.promise(pending.inFlight);
    });
    const afterSend = input && outcome.authorized ? "unknown" : "no";
    if (outcome.type !== "reply") {
      yield* Effect.logDebug("computer-use driver call did not complete", {
        op: request.op,
        outcome: outcome.type,
      });
      return yield* new ComputerDriverError(
        outcome.type === "not-sent" || outcome.type === "cancelled"
          ? {
              kind: "unavailable",
              message: "The computer-use driver could not start.",
              dispatched: "no",
            }
          : outcome.type === "timeout"
            ? {
                kind: "timeout",
                message: "The computer-use driver timed out.",
                dispatched: afterSend,
              }
            : { kind: "failed", message: "The computer-use driver exited.", dispatched: afterSend },
      );
    }
    const decoded = yield* Schema.decodeUnknownEffect(reply)(outcome.message).pipe(
      Effect.tapError(() =>
        Effect.logInfo("computer-use driver answered with an invalid reply", { op: request.op }),
      ),
      Effect.mapError(
        () =>
          new ComputerDriverError({
            kind: "malformed",
            message: "The computer-use driver answered with an invalid reply.",
            dispatched: afterSend,
          }),
      ),
    );
    if (!decoded.ok) {
      yield* Effect.logDebug("computer-use driver refused", {
        op: request.op,
        kind: decoded.error.kind,
        dispatched: decoded.error.dispatched,
      });
      return yield* new ComputerDriverError(decoded.error);
    }
    if (decoded.diagnostics) {
      yield* Effect.logInfo("computer-use window enumeration incomplete", {
        op: request.op,
        windowEnumerationFailures: decoded.diagnostics.windowEnumerationFailures,
      });
    }
    return decoded.result;
  });

  const unavailableStatus = (reason: string): DriverStatus => ({
    available: false,
    accessibility: "unknown",
    reason,
  });

  return {
    status: () =>
      SUPPORTED_PLATFORMS.has(options.platform)
        ? call({ op: "status" }, StatusReply).pipe(
            Effect.catch((error) => Effect.succeed(unavailableStatus(error.message))),
          )
        : Effect.succeed(unavailableStatus(unsupportedReason(options.platform))),
    listWindows: () => call({ op: "listWindows" }, WindowsReply),
    observe: (window, { maxElements }) =>
      call({ op: "observe", window, maxElements }, ObserveReply),
    screenshot: (window, outputPath, { maxSize }) =>
      call({ op: "screenshot", window, outputPath, maxSize }, ScreenshotReply),
    elementAt: (window, point) => call({ op: "elementAt", window, point }, ElementAtReply),
    click: (window, expectBounds, point, { button, count }) =>
      call({ op: "click", window, expectBounds, point, button, count }, InputReply),
    drag: (window, expectBounds, from, to) =>
      call({ op: "drag", window, expectBounds, from, to }, InputReply),
    move: (window, expectBounds, point) =>
      call({ op: "move", window, expectBounds, point }, InputReply),
    scrollAt: (window, expectBounds, point, dx, dy) =>
      call({ op: "scrollAt", window, expectBounds, point, dx, dy }, InputReply),
    typeFocused: (window, text) => call({ op: "typeFocused", window, text }, InputReply),
    press: (element, expect) => call({ op: "press", element, expect }, InputReply),
    setValue: (element, expect, value) =>
      call({ op: "setValue", element, expect, value }, InputReply),
    typeText: (element, expect, text) =>
      call({ op: "typeText", element, expect, text }, InputReply),
    key: (window, keys) => call({ op: "key", window, keys }, InputReply),
    scroll: (element, expect, dx, dy) =>
      call({ op: "scroll", element, expect, dx, dy }, InputReply),
  } satisfies ComputerDriverShape;
});

/**
 * The driver script beside this module: the TS source in development, the
 * built `computer-use-driver.mjs` in `dist`, or a hidden subcommand of the
 * single executable, which has no sibling scripts.
 */
const resolveDriverLaunch = (isExecutable: boolean): DriverWorkerLaunch =>
  isExecutable
    ? { command: process.execPath, args: ["__computer-use-driver"], env: { ...process.env } }
    : {
        command: process.execPath,
        args: [
          NodeURL.fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts")
                ? "../computer-use-driver.ts"
                : "./computer-use-driver.mjs",
              import.meta.url,
            ),
          ),
        ],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };

export const layer: Layer.Layer<ComputerDriver> = Layer.effect(
  ComputerDriver,
  Effect.gen(function* () {
    const isExecutable = yield* HostProcessIsExecutable;
    return yield* makeXa11yComputerDriver({
      platform: yield* HostProcessPlatform,
      launch: () => resolveDriverLaunch(isExecutable),
    });
  }),
);
