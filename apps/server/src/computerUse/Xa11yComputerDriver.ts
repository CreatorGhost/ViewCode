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
 * never a partial success. After an input request reached the worker, a
 * crash, timeout or malformed reply reports `dispatched: "unknown"`.
 *
 * A call interrupted while still queued is never sent. Once sent it runs to
 * completion in the worker; an interrupted caller does not learn the
 * outcome, so it must treat the input as possibly delivered.
 *
 * The worker is recycled after `recycleAfter` requests (xa11y's macOS
 * element cache never shrinks); old handles then read as stale. If a worker
 * died during a click or drag, its replacement first releases the left
 * mouse button, which may still be held.
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
  type DriverDispatchTarget,
  type ComputerDriverShape,
  type DriverStatus,
} from "./ComputerDriver.ts";
import { DRIVER_NONCE_ENV, type DriverOp, type DriverRequest } from "./Xa11yDriverCore.ts";

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

const DEFAULT_TIMEOUTS: Record<DriverOp, number> = {
  status: 10_000,
  releaseMouse: 5_000,
  listWindows: 10_000,
  observe: 15_000,
  screenshot: 30_000,
  elementAt: 8_000,
  press: 10_000,
  setValue: 10_000,
  typeText: 20_000,
  key: 10_000,
  scroll: 10_000,
  click: 10_000,
  drag: 10_000,
  move: 10_000,
  scrollAt: 10_000,
  typeFocused: 20_000,
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
});

type DriverReply<T> =
  | { readonly id: number; readonly ok: true; readonly result: T }
  | { readonly id: number; readonly ok: false; readonly error: typeof DriverFailure.Type };

const replyOf = <S extends Schema.Top>(result: S) =>
  Schema.Union([
    Schema.Struct({ id: Schema.Number, ok: Schema.Literal(true), result }),
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
const InputReply = replyOf(Schema.Null);

type CallOutcome =
  | { readonly type: "reply"; readonly message: unknown }
  /** The request never reached a worker. */
  | { readonly type: "not-sent" }
  /** The caller gave up while the request was still queued; it was never sent. */
  | { readonly type: "cancelled" }
  | { readonly type: "exited" }
  | { readonly type: "timeout" };

const isReplyTo = (message: unknown, id: number): boolean =>
  typeof message === "object" && message !== null && "id" in message && message.id === id;

/** Plain child-process client; the Effect surface wraps it below. */
const makeWorkerClient = (options: Xa11yComputerDriverOptions) => {
  let child: NodeChildProcess.ChildProcess | undefined;
  let nonce = "";
  let served = 0;
  let releaseMouse = false;
  let nextId = 1;
  let settlePending: ((outcome: CallOutcome) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const discard = (worker: NodeChildProcess.ChildProcess) => {
    if (child === worker) child = undefined;
    worker.removeAllListeners();
    worker.on("error", () => undefined);
    worker.kill("SIGKILL");
  };

  const start = (): NodeChildProcess.ChildProcess | undefined => {
    const launch = options.launch();
    nonce = NodeCrypto.randomBytes(32).toString("hex");
    served = 0;
    let worker: NodeChildProcess.ChildProcess;
    try {
      worker = NodeChildProcess.spawn(launch.command, [...launch.args], {
        env: { ...launch.env, [DRIVER_NONCE_ENV]: nonce },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        windowsHide: true,
      });
    } catch {
      return undefined;
    }
    worker.on("message", (message) => settlePending?.({ type: "reply", message }));
    worker.once("error", () => {
      if (child === worker) child = undefined;
      // `pid` is unset only when the spawn itself failed.
      settlePending?.(worker.pid === undefined ? { type: "not-sent" } : { type: "exited" });
    });
    worker.once("exit", () => {
      if (child === worker) child = undefined;
      settlePending?.({ type: "exited" });
    });
    return worker;
  };

  const run = (
    request: DriverRequest,
    authorize?: (target: DriverDispatchTarget) => Promise<ComputerUseError | undefined>,
  ): Promise<CallOutcome> =>
    new Promise((resolve) => {
      if (closed) return resolve({ type: "not-sent" });
      child ??= start();
      const worker = child;
      if (!worker?.connected) {
        if (worker) discard(worker);
        return resolve({ type: "not-sent" });
      }
      const id = nextId++;
      const timeout = setTimeout(() => {
        discard(worker);
        settle({ type: "timeout" });
      }, options.timeouts?.[request.op] ?? DEFAULT_TIMEOUTS[request.op]);
      const settle = (outcome: CallOutcome) => {
        if (settlePending !== settle) return;
        if (
          outcome.type === "reply" &&
          isReplyTo(outcome.message, id) &&
          typeof outcome.message === "object" &&
          outcome.message !== null &&
          "authorize" in outcome.message
        ) {
          const target = outcome.message.authorize as DriverDispatchTarget;
          void (authorize ? authorize(target) : Promise.resolve(undefined)).then(
            (decision) => {
              if (settlePending === settle)
                worker.send({ id, nonce, decision: decision ?? null }, (error) => {
                  if (error) {
                    discard(worker);
                    settle({ type: "exited" });
                  }
                });
            },
            () => {
              discard(worker);
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
          discard(worker);
          resolve({ type: "reply", message: undefined });
          return;
        }
        if (outcome.type !== "reply" && MOUSE_BUTTON_OPS.has(request.op)) releaseMouse = true;
        served += 1;
        if (served >= (options.recycleAfter ?? DEFAULT_RECYCLE_AFTER)) discard(worker);
        resolve(outcome);
      };
      settlePending = settle;
      try {
        worker.send({ id, nonce, request }, (error) => {
          if (error) {
            discard(worker);
            settle({ type: "not-sent" });
          }
        });
      } catch {
        discard(worker);
        settle({ type: "not-sent" });
      }
    });

  return {
    call: (
      request: DriverRequest,
      cancelled: () => boolean,
      authorize: (target: DriverDispatchTarget) => Promise<ComputerUseError | undefined>,
    ): Promise<CallOutcome> => {
      const result = queue.then(async (): Promise<CallOutcome> => {
        if (cancelled()) return { type: "cancelled" };
        if (releaseMouse) {
          releaseMouse = false;
          await run({ op: "releaseMouse" });
        }
        if (cancelled()) return { type: "cancelled" };
        return run(request, authorize);
      });
      queue = result;
      return result;
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
  const client = makeWorkerClient(options);
  yield* Effect.addFinalizer(() => Effect.sync(client.close));

  const call = Effect.fnUntraced(function* <T>(
    request: DriverRequest,
    reply: Schema.Decoder<DriverReply<T>>,
  ) {
    const input = INPUT_OPS.has(request.op);
    const afterSend = input ? "unknown" : "no";
    if (!SUPPORTED_PLATFORMS.has(options.platform)) {
      return yield* new ComputerDriverError({
        kind: "unavailable",
        message: unsupportedReason(options.platform),
        dispatched: "no",
      });
    }
    // Interrupting the caller marks the queued request so it is never sent.
    const check = yield* ComputerDriverDispatchCheck;
    const context = yield* Effect.context();
    const outcome = yield* Effect.callback<CallOutcome>((resume, signal) => {
      void client
        .call(
          request,
          () => signal.aborted,
          async (target) => {
            const cancelled: ComputerUseError = {
              code: "CU-CON-004",
              message: "The action was cancelled before dispatch.",
              effect: "not-dispatched",
            };
            if (signal.aborted) return cancelled;
            const refusal = await Effect.runPromiseWith(context)(check(target));
            return signal.aborted ? cancelled : refusal;
          },
        )
        .then((value) => resume(Effect.succeed(value)));
    });
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
      call({ op: "click", window, expectBounds, point, button, count }, InputReply).pipe(
        Effect.asVoid,
      ),
    drag: (window, expectBounds, from, to) =>
      call({ op: "drag", window, expectBounds, from, to }, InputReply).pipe(Effect.asVoid),
    move: (window, expectBounds, point) =>
      call({ op: "move", window, expectBounds, point }, InputReply).pipe(Effect.asVoid),
    scrollAt: (window, expectBounds, point, dx, dy) =>
      call({ op: "scrollAt", window, expectBounds, point, dx, dy }, InputReply).pipe(Effect.asVoid),
    typeFocused: (window, text) =>
      call({ op: "typeFocused", window, text }, InputReply).pipe(Effect.asVoid),
    press: (element, expect) =>
      call({ op: "press", element, expect }, InputReply).pipe(Effect.asVoid),
    setValue: (element, expect, value) =>
      call({ op: "setValue", element, expect, value }, InputReply).pipe(Effect.asVoid),
    typeText: (element, expect, text) =>
      call({ op: "typeText", element, expect, text }, InputReply).pipe(Effect.asVoid),
    key: (window, keys) => call({ op: "key", window, keys }, InputReply).pipe(Effect.asVoid),
    scroll: (element, expect, dx, dy) =>
      call({ op: "scroll", element, expect, dx, dy }, InputReply).pipe(Effect.asVoid),
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
