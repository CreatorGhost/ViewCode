/**
 * The server-side gate for computer use. Every `viewcode-computer` call lands
 * here through `POST /api/computer-use`, already bound to the thread its
 * session credential was issued for. This service decides what the call may
 * do (setting, running turn, denylist, approval) and only then reaches the
 * driver. It must stay safe when the agent ignores every instruction and
 * sends raw requests itself: nothing here trusts the CLI's own checks.
 *
 * State is in memory and per thread: window ids, element refs, a routine-input
 * grant for the current turn, and pending approvals. `ProviderService` clears
 * it when a turn ends or the session stops; a server restart forgets it.
 */
import * as NodeCrypto from "node:crypto";

import {
  COMPUTER_USE_DEFAULT_SCREENSHOT_SIZE,
  EventId,
  isProviderDriverKind,
  RuntimeRequestId,
  type ComputerUseApprovals,
  type ComputerUseElement,
  type ComputerUseError,
  type ComputerUseMode,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseResult,
  type ComputerUseStatus,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerProcessAncestry } from "./computerUseAncestry.ts";
import {
  ComputerDriver,
  ComputerDriverError,
  ComputerDriverDispatchCheck,
  type DriverDispatchDecision,
  type DriverDispatchPhase,
  type DriverDispatchTarget,
} from "./ComputerDriver.ts";
import {
  computerUseError,
  describeInputForApproval,
  driverErrorToComputerUseError,
  inputNeedsApproval,
  isDenylistedApp,
  isProtectedApp,
  rectsIntersect,
  isDestructiveChord,
  isDestructiveTarget,
  isInputRequest,
  validateComputerUseRequest,
  type ComputerUseInputRequest,
} from "./computerUsePolicy.ts";
import {
  ThreadTargets,
  type RefRecord,
  type ShotRecord,
  type WindowRecord,
} from "./computerUseTargets.ts";
import { clipValue } from "./Xa11yDriverCore.ts";

/** Who is calling: resolved from the session credential, never from the body. */
export interface ComputerUseCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export type ComputerUseApprovalResponse =
  /** A pending computer-use approval took the decision. */
  | "handled"
  /** A computer-use request id that is no longer pending (answered, cancelled, or from before a restart). */
  | "stale"
  /** Not a computer-use request; route it to the provider adapter. */
  | "not-owned";

export interface ComputerUseServiceShape {
  /** Runs one request. Never fails: refusals and driver errors are responses. */
  readonly handle: (caller: ComputerUseCaller, body: unknown) => Effect.Effect<ComputerUseResponse>;
  /** Fresh every call: the setting plus what the driver can do right now. */
  readonly status: Effect.Effect<ComputerUseStatus>;
  /**
   * Where approval requests are published. `ProviderService` attaches its
   * runtime event bus so every client renders them like provider approvals.
   */
  readonly attachRuntimeEventPublisher: (
    publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly respondToApproval: (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly decision: ProviderApprovalDecision;
  }) => Effect.Effect<ComputerUseApprovalResponse>;
  /** A turn ended or was interrupted: cancel its approvals and drop its grant. */
  readonly endTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void>;
  /** The thread's session stopped: forget its windows, refs, grant and approvals. */
  readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
  /** Records provider requests before clients see them, without waiting for projection. */
  readonly trackProviderApproval: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}

/**
 * Whether any provider approval is waiting in a live thread. Computer use
 * pauses all input while one is open (its own approvals are tracked in memory
 * and excluded here by their `computer-use:` request id).
 */
export class ComputerUsePendingApprovals extends Context.Service<
  ComputerUsePendingApprovals,
  /** Fails closed: an unreadable projection counts as pending. */
  { readonly anyPending: Effect.Effect<boolean> }
>()("t3/computerUse/ComputerUseService/ComputerUsePendingApprovals") {}

/** Reads the projection: one indexed lookup, no thread snapshot. */
export const pendingApprovalsLayer = Layer.effect(
  ComputerUsePendingApprovals,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ComputerUsePendingApprovals.of({
      anyPending: sql<{ readonly pending: number }>`
        SELECT 1 AS pending
        FROM projection_pending_approvals AS approvals
        JOIN projection_threads AS threads ON threads.thread_id = approvals.thread_id
        WHERE approvals.status = 'pending'
          AND approvals.request_id NOT LIKE ${`${REQUEST_ID_PREFIX}%`}
          AND threads.archived_at IS NULL
          AND threads.deleted_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => true),
      ),
    });
  }),
);

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  ComputerUseServiceShape
>()("t3/computerUse/ComputerUseService") {}

const REQUEST_ID_PREFIX = "computer-use:";
const APPROVAL_APP_NAME = "Computer use";
/** No answer within this long counts as a decline. */
const APPROVAL_TIMEOUT = Duration.minutes(10);
const MAX_OBSERVED_ELEMENTS = 300;
/** Recent screenshots are the agent's working memory in coordinate mode. */
const SCREENSHOTS_KEPT = 8;

/**
 * How long input gets to take effect before the follow-up screenshot.
 * A reference so tests run with zero instead of sleeping.
 */
export const ComputerUseSettleDelay = Context.Reference<Duration.Duration>(
  "t3/computerUse/ComputerUseSettleDelay",
  { defaultValue: () => Duration.millis(350) },
);

const ROUTINE_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow for the rest of this turn" },
  { decision: "decline", label: "Decline" },
];
const DESTRUCTIVE_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  {
    decision: "accept",
    label: "Allow once",
    warning: "Looks destructive, so this always asks",
  },
  { decision: "decline", label: "Decline" },
];

interface TurnContext {
  readonly turnId: TurnId;
  readonly provider: ProviderDriverKind;
  readonly fullAccess: boolean;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly deferred: Deferred.Deferred<ProviderApprovalDecision>;
}

type ResolvedInputTarget =
  | { readonly _tag: "Element"; readonly window: WindowRecord; readonly ref: RefRecord }
  | { readonly _tag: "Window"; readonly window: WindowRecord }
  | { readonly _tag: "Shot"; readonly window: WindowRecord; readonly shot: ShotRecord };

/** The image pixels a coordinate command names, in order. */
const requestPixels = (
  request: ComputerUseInputRequest,
): ReadonlyArray<{ readonly x: number; readonly y: number }> => {
  switch (request.command) {
    case "click":
    case "move":
    case "scroll-at":
      return [{ x: request.x, y: request.y }];
    case "drag":
      return [
        { x: request.fromX, y: request.fromY },
        { x: request.toX, y: request.toY },
      ];
    default:
      return [];
  }
};

/** Pixel centre → logical screen point, through the screen rect the image covers. */
export const toScreenPoint = (
  shot: Pick<ShotRecord, "width" | "height" | "bounds">,
  x: number,
  y: number,
) => ({
  x: shot.bounds.x + ((x + 0.5) * shot.bounds.width) / shot.width,
  y: shot.bounds.y + ((y + 0.5) * shot.bounds.height) / shot.height,
});

const ok = (result: ComputerUseResult): ComputerUseResponse => ({ ok: true, result });
const refused = (error: ComputerUseError): ComputerUseResponse => ({ ok: false, error });

/** Thread ids are opaque; keep them from becoming path syntax. */
const threadDirName = (threadId: ThreadId) => threadId.replaceAll(/[^A-Za-z0-9._-]/g, "_");

export const make = Effect.gen(function* () {
  const driver = yield* ComputerDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const settleDelay = yield* ComputerUseSettleDelay;
  const pendingProviderApprovals = yield* ComputerUsePendingApprovals;
  const ownProcesses = yield* ServerProcessAncestry;
  /**
   * Held from the final check of an input until its native action returns,
   * and while an approval is published or tracked, so no approval can open
   * between that check and the input landing. Not held while a request waits
   * for the driver or prepares its target.
   */
  const dispatchLock = yield* Semaphore.make(1);

  const targetsByThread = new Map<ThreadId, ThreadTargets>();
  const turnGrants = new Map<ThreadId, TurnId>();
  const lastRunningTurn = new Map<ThreadId, TurnId>();
  const endedTurns = new Map<ThreadId, TurnId>();
  const pending = new Map<string, PendingApproval>();
  /** Provider requests waiting for the user, by `thread:request`, before the projection shows them. */
  const liveProviderApprovals = new Map<
    string,
    { readonly threadId: ThreadId; readonly turnId: TurnId | undefined }
  >();
  const screenshotCounters = new Map<ThreadId, number>();
  const screenshotNumbering = yield* Semaphore.make(1);
  let publisher: ((event: ProviderRuntimeEvent) => Effect.Effect<void>) | undefined;

  /** ViewCode by name, or a window of this server's own process ancestry. */
  const isDenied = (window: Pick<WindowRecord, "app" | "appIdentifier" | "pid">) =>
    isDenylistedApp(window) || ownProcesses.has(window.pid);

  const targetsFor = (threadId: ThreadId) => {
    let targets = targetsByThread.get(threadId);
    if (!targets) {
      targets = new ThreadTargets();
      targetsByThread.set(threadId, targets);
    }
    return targets;
  };

  const currentMode: Effect.Effect<ComputerUseMode> = settings.getSettings.pipe(
    Effect.map((value) => value.computerUse),
    // An unreadable settings file must never turn computer use on.
    Effect.orElseSucceed(() => "off" as const),
  );

  /** Re-read per request and at the final check, like the mode. */
  const currentApprovals: Effect.Effect<ComputerUseApprovals> = settings.getSettings.pipe(
    Effect.map((value) => value.computerUseApprovals),
    // Unreadable settings fall back to the strictest behaviour.
    Effect.orElseSucceed(() => "thread" as const),
  );

  /** The thread's running turn as orchestration sees it, or undefined. */
  const runningTurn = (caller: ComputerUseCaller) =>
    projection.getThreadShellById(caller.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
      Effect.map((thread): TurnContext | undefined => {
        const session = thread?.session;
        if (!thread || !session || session.status !== "running" || !session.activeTurnId) {
          return undefined;
        }
        // A credential minted for an earlier provider instance must not act
        // inside the turn of whatever replaced it.
        if (
          session.providerInstanceId !== undefined &&
          session.providerInstanceId !== caller.providerInstanceId
        ) {
          return undefined;
        }
        if (!isProviderDriverKind(session.providerName)) return undefined;
        if (endedTurns.get(caller.threadId) === session.activeTurnId) return undefined;
        lastRunningTurn.set(caller.threadId, session.activeTurnId);
        return {
          turnId: session.activeTurnId,
          provider: session.providerName,
          // The thread's mode can change mid-session while the provider keeps
          // the old one until it restarts; auto-allow only when both agree.
          fullAccess: thread.runtimeMode === "full-access" && session.runtimeMode === "full-access",
        };
      }),
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const publish = (event: ProviderRuntimeEvent) => (publisher ? publisher(event) : Effect.void);

  /** Resolves a pending approval exactly once and tells clients it closed. */
  const settle = (requestId: string, decision: ProviderApprovalDecision) =>
    Effect.gen(function* () {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      yield* Deferred.succeed(entry.deferred, decision);
      yield* publish({
        eventId: EventId.make(`${requestId}:resolved`),
        type: "request.resolved",
        provider: entry.provider,
        providerInstanceId: entry.providerInstanceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        requestId: RuntimeRequestId.make(requestId),
        createdAt: yield* nowIso,
        payload: { requestType: "permission_approval", decision },
      });
    });

  const askUser = (input: {
    readonly caller: ComputerUseCaller;
    readonly turn: TurnContext;
    readonly detail: string;
    readonly destructive: boolean;
  }) =>
    Effect.gen(function* () {
      if (!publisher) return "decline" as const;
      const requestId = `${REQUEST_ID_PREFIX}${NodeCrypto.randomUUID()}`;
      const deferred = yield* Deferred.make<ProviderApprovalDecision>();
      return yield* Effect.gen(function* () {
        const opened = yield* dispatchLock.withPermits(1)(
          Effect.gen(function* () {
            if (yield* approvalPending) return false;
            pending.set(requestId, {
              threadId: input.caller.threadId,
              turnId: input.turn.turnId,
              provider: input.turn.provider,
              providerInstanceId: input.caller.providerInstanceId,
              deferred,
            });
            yield* publish({
              eventId: EventId.make(`${requestId}:opened`),
              type: "request.opened",
              provider: input.turn.provider,
              providerInstanceId: input.caller.providerInstanceId,
              threadId: input.caller.threadId,
              turnId: input.turn.turnId,
              requestId: RuntimeRequestId.make(requestId),
              createdAt: yield* nowIso,
              payload: {
                requestType: "permission_approval",
                appName: APPROVAL_APP_NAME,
                detail: input.detail,
                options: input.destructive ? DESTRUCTIVE_OPTIONS : ROUTINE_OPTIONS,
              },
            });
            return true;
          }),
        );
        if (!opened) return "paused" as const;
        const decision = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(APPROVAL_TIMEOUT),
          Effect.map(Option.getOrElse((): ProviderApprovalDecision => "cancel")),
          // The CLI gave up (its shell tool timed out or was stopped): close the card.
          Effect.onInterrupt(() => settle(requestId, "cancel")),
        );
        yield* settle(requestId, decision);
        return decision;
      }).pipe(Effect.ensuring(settle(requestId, "cancel")));
    });

  const logOutcome = (
    caller: ComputerUseCaller,
    request: ComputerUseRequest | undefined,
    response: ComputerUseResponse,
  ) =>
    // Ids, command and outcome only: never text, values, labels, titles or paths.
    Effect.logDebug("computer use request", {
      threadId: caller.threadId,
      command: request?.command,
      ...(request && "window" in request ? { window: request.window } : {}),
      ...(request && "ref" in request ? { ref: request.ref } : {}),
      ...(response.ok
        ? { outcome: "ok", ...(response.result.kind === "input" ? { effect: "dispatched" } : {}) }
        : {
            outcome: "refused",
            code: response.error.code,
            ...(response.error.effect ? { effect: response.error.effect } : {}),
          }),
    });

  const windowFor = (caller: ComputerUseCaller, windowId: number) => {
    const window = targetsFor(caller.threadId).window(windowId);
    if (!window) {
      return refused(
        computerUseError(
          "CU-NOT-001",
          `Window ${windowId} is not known to this thread (never listed, or closed). Run \`viewcode-computer list-windows\`.`,
        ),
      );
    }
    if (isDenied(window)) return deniedApp();
    return window;
  };

  const deniedApp = (effect?: "not-dispatched") =>
    refused(
      computerUseError(
        "CU-CON-005",
        "This app can never be observed or controlled through computer use (password managers, system settings and ViewCode itself). Ask the user to do this step.",
        effect,
      ),
    );

  /** A stale window handle means the window closed under us. */
  const windowGone = (
    caller: ComputerUseCaller,
    window: WindowRecord,
    effect?: ComputerUseError["effect"],
  ) => {
    targetsFor(caller.threadId).closeWindow(window.id);
    return refused(
      computerUseError(
        "CU-NOT-001",
        `Window ${window.id} is closed. Run \`viewcode-computer list-windows\`.`,
        effect,
      ),
    );
  };

  const listWindows = (caller: ComputerUseCaller, app: string | undefined) =>
    driver.listWindows().pipe(
      Effect.map((listed) => {
        const records = targetsFor(caller.threadId).recordWindows(listed);
        const filter = app?.trim().toLowerCase();
        const windows = listed.flatMap((window, index) => {
          const record = records[index];
          if (!record) return [];
          if (filter && !window.app.toLowerCase().includes(filter)) return [];
          return [
            {
              id: record.id,
              app: window.app,
              pid: window.pid,
              title: window.title,
              focused: window.focused,
              ...(window.bounds ? { bounds: window.bounds } : {}),
            },
          ];
        });
        return ok({ kind: "windows", windows });
      }),
      Effect.catchTag("ComputerDriverError", (error) =>
        Effect.succeed(refused(driverErrorToComputerUseError(error, { input: false }))),
      ),
    );

  /** Re-reads titles and handles before acting on a window; a driver failure is the response. */
  const refreshWindows = (caller: ComputerUseCaller) =>
    driver.listWindows().pipe(
      Effect.map((listed) => {
        targetsFor(caller.threadId).recordWindows(listed);
        return undefined;
      }),
      Effect.catchTag("ComputerDriverError", (error) =>
        Effect.succeed(refused(driverErrorToComputerUseError(error, { input: false }))),
      ),
    );

  const observe = (caller: ComputerUseCaller, windowId: number, query: string | undefined) =>
    Effect.gen(function* () {
      const cached = windowFor(caller, windowId);
      if ("ok" in cached) return cached;
      const refreshed = yield* refreshWindows(caller);
      if (refreshed) return refreshed;
      const window = windowFor(caller, windowId);
      if ("ok" in window) return window;
      const observed = yield* driver
        .observe(window.handle, { maxElements: MAX_OBSERVED_ELEMENTS })
        .pipe(
          Effect.map((value) => ({ _tag: "Observed" as const, value })),
          Effect.catchTag("ComputerDriverError", (error) =>
            Effect.succeed({ _tag: "Failed" as const, error }),
          ),
        );
      if (observed._tag === "Failed") {
        return observed.error.kind === "stale"
          ? windowGone(caller, window)
          : refused(driverErrorToComputerUseError(observed.error, { input: false }));
      }
      const needle = query?.trim().toLowerCase();
      const matching = needle
        ? observed.value.elements.filter(
            (element) =>
              element.label.toLowerCase().includes(needle) ||
              (element.value?.toLowerCase().includes(needle) ?? false),
          )
        : observed.value.elements;
      const minted = targetsFor(caller.threadId).recordObservation(window.id, matching);
      const elements = minted.map(({ ref, element }): ComputerUseElement => ({
        ref,
        role: element.role,
        label: element.label,
        ...(element.value !== undefined ? { value: element.value } : {}),
        enabled: element.enabled,
        focused: element.focused,
      }));
      return ok({
        kind: "observation",
        window: window.id,
        elements,
        truncated: observed.value.truncated,
      });
    });

  const nextScreenshotPath = (threadId: ThreadId) =>
    screenshotNumbering.withPermits(1)(
      Effect.gen(function* () {
        const directory = path.join(
          config.stateDir,
          "computer-use",
          "screenshots",
          threadDirName(threadId),
        );
        yield* fs.makeDirectory(directory, { recursive: true });
        let last = screenshotCounters.get(threadId);
        if (last === undefined) {
          // Continue after files left by an earlier server run so retention
          // never mistakes a new capture for an old one.
          const existing = yield* fs.readDirectory(directory);
          last = Math.max(
            0,
            ...existing.map((name) => Number.parseInt(name, 10)).filter(Number.isFinite),
          );
        }
        const next = last + 1;
        screenshotCounters.set(threadId, next);
        return { directory, file: path.join(directory, `${next}.png`) };
      }),
    );

  const pruneScreenshots = (directory: string) =>
    Effect.gen(function* () {
      const numbered = (yield* fs.readDirectory(directory))
        .filter((name) => /^\d+\.png$/.test(name))
        .toSorted((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10));
      yield* Effect.forEach(
        numbered.slice(SCREENSHOTS_KEPT),
        (name) => fs.remove(path.join(directory, name), { force: true }),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not prune computer-use screenshots", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    );

  /**
   * Whether a password manager or security window overlaps the target. A
   * region capture shows whatever is on top, so it would leak that window.
   * Unknown bounds count as overlapping.
   */
  const protectedOverlay = (window: WindowRecord) =>
    driver.listWindows().pipe(
      Effect.map((listed) => {
        const live = listed.find((entry) => entry.handle === window.handle);
        if (live && isDenied(live)) return true;
        const target = live?.bounds;
        return listed.some(
          (entry) =>
            entry.handle !== window.handle &&
            isProtectedApp(entry) &&
            (!target || !entry.bounds || rectsIntersect(target, entry.bounds)),
        );
      }),
    );

  /** Captures a window and makes the image its newest shot. */
  const capture = (caller: ComputerUseCaller, window: WindowRecord, maxSize: number) =>
    Effect.gen(function* () {
      const overlaid = yield* protectedOverlay(window).pipe(
        Effect.map((value) => ({ _tag: "Checked" as const, value })),
        Effect.catchTag("ComputerDriverError", (error) =>
          Effect.succeed({ _tag: "Failed" as const, error }),
        ),
      );
      if (overlaid._tag === "Failed") return overlaid;
      if (overlaid.value) return { _tag: "Overlaid" as const };
      const target = yield* nextScreenshotPath(caller.threadId);
      const captured = yield* driver.screenshot(window.handle, target.file, { maxSize }).pipe(
        Effect.map((value) => ({ _tag: "Captured" as const, value })),
        Effect.catchTag("ComputerDriverError", (error) =>
          Effect.succeed({ _tag: "Failed" as const, error }),
        ),
      );
      if (captured._tag === "Failed") return captured;
      // A protected window may have appeared while the capture ran.
      const after = yield* protectedOverlay(window).pipe(
        Effect.map((overlaid) => (overlaid ? { _tag: "Overlaid" as const } : undefined)),
        Effect.catchTag("ComputerDriverError", (error) =>
          Effect.succeed({ _tag: "Failed" as const, error }),
        ),
      );
      if (after) {
        yield* fs.remove(target.file, { force: true }).pipe(Effect.ignore);
        return after;
      }
      yield* pruneScreenshots(target.directory);
      const shot = targetsFor(caller.threadId).recordShot(window.id, {
        handle: window.handle,
        width: captured.value.width,
        height: captured.value.height,
        bounds: captured.value.bounds,
        maxSize,
      });
      return {
        _tag: "Captured" as const,
        fields: {
          shot: shot.shot,
          window: window.id,
          path: target.file,
          width: shot.width,
          height: shot.height,
        },
      };
    });

  const screenshot = (caller: ComputerUseCaller, windowId: number, maxSize: number | undefined) =>
    Effect.gen(function* () {
      const cached = windowFor(caller, windowId);
      if ("ok" in cached) return cached;
      const refreshed = yield* refreshWindows(caller);
      if (refreshed) return refreshed;
      const window = windowFor(caller, windowId);
      if ("ok" in window) return window;
      const captured = yield* capture(
        caller,
        window,
        maxSize ?? COMPUTER_USE_DEFAULT_SCREENSHOT_SIZE,
      );
      if (captured._tag === "Overlaid") {
        return refused(
          computerUseError(
            "CU-CON-005",
            "A protected window overlaps this window; move it away and try again.",
          ),
        );
      }
      if (captured._tag === "Failed") {
        return captured.error.kind === "stale"
          ? windowGone(caller, window)
          : refused(driverErrorToComputerUseError(captured.error, { input: false }));
      }
      return ok({ kind: "screenshot", ...captured.fields });
    });

  const unknownWindow = (windowId: number) =>
    refused(
      computerUseError(
        "CU-NOT-001",
        `Window ${windowId} is not known to this thread (never listed, or closed). Run \`viewcode-computer list-windows\`.`,
        "not-dispatched",
      ),
    );

  const resolveInputTarget = (
    caller: ComputerUseCaller,
    request: ComputerUseInputRequest,
  ): ResolvedInputTarget | ComputerUseResponse => {
    const targets = targetsFor(caller.threadId);
    switch (request.command) {
      case "key":
      case "type-focused": {
        const window = targets.window(request.window);
        if (!window) return unknownWindow(request.window);
        return isDenied(window) ? deniedApp("not-dispatched") : { _tag: "Window", window };
      }
      case "click":
      case "drag":
      case "move":
      case "scroll-at": {
        const lookup = targets.lookupShot(request.shot);
        if (lookup._tag === "Unknown") {
          return refused(
            computerUseError(
              "CU-NOT-003",
              `Shot ${request.shot} is not known to this thread. Take a screenshot first.`,
              "not-dispatched",
            ),
          );
        }
        if (lookup._tag === "Retired") {
          return refused(
            computerUseError(
              "CU-CON-007",
              lookup.reason === "window-closed"
                ? `Shot ${request.shot} shows a window that closed. Run \`viewcode-computer list-windows\`.`
                : `Shot ${request.shot} is not the newest screenshot of its window; use the newest shot (every input returns one) or take a new screenshot.`,
              "not-dispatched",
            ),
          );
        }
        if (isDenied(lookup.window)) return deniedApp("not-dispatched");
        const outside = requestPixels(request).some(
          ({ x, y }) => x >= lookup.shot.width || y >= lookup.shot.height,
        );
        if (outside) {
          return refused(
            computerUseError(
              "CU-VAL-003",
              `A point is outside shot ${request.shot}, which is ${lookup.shot.width}×${lookup.shot.height} pixels.`,
              "not-dispatched",
            ),
          );
        }
        return { _tag: "Shot", window: lookup.window, shot: lookup.shot };
      }
      case "press":
      case "set-value":
      case "type":
      case "scroll": {
        const lookup = targets.lookupRef(request.ref);
        switch (lookup._tag) {
          case "Unknown":
            return refused(
              computerUseError(
                "CU-NOT-002",
                `Ref ${request.ref} is not known to this thread. Observe the window to get refs.`,
                "not-dispatched",
              ),
            );
          case "Retired":
            return refused(
              computerUseError(
                "CU-CON-003",
                lookup.reason === "window-closed"
                  ? `Ref ${request.ref} belongs to a window that closed. Run \`viewcode-computer list-windows\`.`
                  : `Ref ${request.ref} is from an older observation; observe again.`,
                "not-dispatched",
              ),
            );
          case "Found":
            return isDenied(lookup.window)
              ? deniedApp("not-dispatched")
              : { _tag: "Element", window: lookup.window, ref: lookup.ref };
        }
      }
    }
  };

  const dispatchInput = (request: ComputerUseInputRequest, target: ResolvedInputTarget) => {
    if (target._tag === "Window") {
      return request.command === "key"
        ? driver.key(target.window.handle, request.keys)
        : request.command === "type-focused"
          ? driver.typeFocused(target.window.handle, request.text)
          : Effect.die("window target for a non-window command");
    }
    if (target._tag === "Shot") {
      const { shot } = target;
      const at = (x: number, y: number) => toScreenPoint(shot, x, y);
      switch (request.command) {
        case "click":
          return driver.click(shot.handle, shot.bounds, at(request.x, request.y), {
            button: request.button ?? "left",
            count: request.count ?? 1,
          });
        case "drag":
          return driver.drag(
            shot.handle,
            shot.bounds,
            at(request.fromX, request.fromY),
            at(request.toX, request.toY),
          );
        case "move":
          return driver.move(shot.handle, shot.bounds, at(request.x, request.y));
        case "scroll-at":
          return driver.scrollAt(
            shot.handle,
            shot.bounds,
            at(request.x, request.y),
            request.dx,
            request.dy,
          );
        default:
          return Effect.die("shot target for a non-coordinate command");
      }
    }
    const expect = { role: target.ref.role, label: target.ref.label };
    switch (request.command) {
      case "press":
        return driver.press(target.ref.handle, expect);
      case "set-value":
        return driver.setValue(target.ref.handle, expect, request.value);
      case "type":
        return driver.typeText(target.ref.handle, expect, request.text);
      case "scroll":
        return driver.scroll(target.ref.handle, expect, request.dx, request.dy);
      default:
        return Effect.die("element target for a non-element command");
    }
  };

  /** What a coordinate command's (first) point lands on; best effort. */
  const hitFor = (request: ComputerUseInputRequest, target: ResolvedInputTarget) => {
    if (target._tag !== "Shot") return Effect.undefined;
    const [first] = requestPixels(request);
    if (!first) return Effect.undefined;
    return driver
      .elementAt(target.shot.handle, toScreenPoint(target.shot, first.x, first.y))
      .pipe(Effect.orElseSucceed(() => null));
  };

  const inputFailure = (
    caller: ComputerUseCaller,
    target: ResolvedInputTarget,
    error: ComputerDriverError,
  ): ComputerUseResponse => {
    if (error.kind === "stale" && target._tag === "Shot") {
      targetsFor(caller.threadId).retireShot(target.shot.shot);
      return refused(
        computerUseError(
          "CU-CON-007",
          `The window moved, resized or closed since shot ${target.shot.shot}; take a new screenshot.`,
          driverErrorToComputerUseError(error, { input: true }).effect,
        ),
      );
    }
    if (error.kind === "stale" && target._tag === "Window") {
      return windowGone(
        caller,
        target.window,
        driverErrorToComputerUseError(error, { input: true }).effect,
      );
    }
    return refused(driverErrorToComputerUseError(error, { input: true }));
  };

  /** The window shortly after an action, so the agent continues from what is there now. */
  const afterAction = (caller: ComputerUseCaller, window: WindowRecord) =>
    Effect.gen(function* () {
      if (Duration.toMillis(settleDelay) > 0) yield* Effect.sleep(settleDelay);
      const maxSize =
        targetsFor(caller.threadId).latestShot(window.id)?.maxSize ??
        COMPUTER_USE_DEFAULT_SCREENSHOT_SIZE;
      const captured = yield* capture(caller, window, maxSize);
      // No Screen Recording permission, or the window went away: the action
      // still happened, so report it without a picture.
      return captured._tag === "Captured" ? captured.fields : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));

  const noTurn = (message: string, code: "CU-CON-006" | "CU-CON-004") =>
    refused(computerUseError(code, message, "not-dispatched"));

  const inputPaused = refused(
    computerUseError(
      "CU-CON-008",
      "Input is paused while an approval waits for the user; wait for it to be answered, then observe again.",
      "not-dispatched",
    ),
  );

  /**
   * Any approval waiting anywhere in this environment: ours (any thread) or a
   * provider's. While one is open no input runs, so nothing can click an
   * approval card, wherever it is shown. Unreadable counts as pending.
   */
  const approvalPending = Effect.suspend(() =>
    pending.size > 0 || liveProviderApprovals.size > 0
      ? Effect.succeed(true)
      : pendingProviderApprovals.anyPending,
  );

  const sameTarget = (left: ResolvedInputTarget, right: ResolvedInputTarget) =>
    left._tag === right._tag &&
    left.window.id === right.window.id &&
    left.window.handle === right.window.handle &&
    (left._tag !== "Element" || (right._tag === "Element" && left.ref.ref === right.ref.ref)) &&
    (left._tag !== "Shot" || (right._tag === "Shot" && left.shot.shot === right.shot.shot));

  /**
   * The last gate before the desktop, on every input path (asked or
   * auto-allowed): the setting, the same running turn, no approval open, and
   * the target still current. Checked once here to fail fast, then by the
   * driver for the exact native target before it prepares anything and again
   * immediately before input. That last check takes `dispatchLock` and an
   * allowed one keeps it until the native action returned.
   */
  const checkAndDispatch = (
    caller: ComputerUseCaller,
    request: ComputerUseInputRequest,
    turn: TurnContext,
    resolved: ResolvedInputTarget,
    asked: boolean,
    destructive: boolean,
  ) =>
    Effect.gen(function* () {
      // Only element targets and clicks were checked for destructiveness up
      // front; a move or scroll over a "Delete" button is not asked about.
      const destructiveApplies = resolved._tag === "Element" || request.command === "click";
      const check = (native?: DriverDispatchTarget) =>
        Effect.gen(function* () {
          if ((yield* currentMode) !== "control") {
            return refused(
              computerUseError(
                "CU-CON-002",
                "Computer use no longer allows input.",
                "not-dispatched",
              ),
            );
          }
          const stillRunning = yield* runningTurn(caller);
          if (stillRunning?.turnId !== turn.turnId) {
            return noTurn(
              "The turn ended before the action ran.",
              asked ? "CU-CON-004" : "CU-CON-006",
            );
          }
          if (yield* approvalPending) return inputPaused;
          // Fresh, so switching to a stricter setting (or leaving Full access)
          // mid-action never lets an input through that would now ask.
          const approvals = yield* currentApprovals;
          if (
            !asked &&
            inputNeedsApproval(approvals, {
              destructive,
              granted: stillRunning.fullAccess || turnGrants.get(caller.threadId) === turn.turnId,
            })
          ) {
            return noTurn(
              "The thread now requires approval; request the action again.",
              "CU-CON-004",
            );
          }
          const fresh = resolveInputTarget(caller, request);
          if ("ok" in fresh) return fresh;
          if (!sameTarget(resolved, fresh)) {
            return refused(
              computerUseError(
                fresh._tag === "Shot" ? "CU-CON-007" : "CU-CON-003",
                "The target changed since this action was checked; look again.",
                "not-dispatched",
              ),
            );
          }
          if (native) {
            if (native.window.handle !== fresh.window.handle) {
              return noTurn("The native target changed before dispatch.", "CU-CON-004");
            }
            if (isDenied(native.window)) return deniedApp("not-dispatched");
            // The label as the agent and the up-front check saw it.
            if (
              approvals !== "never" &&
              !destructive &&
              destructiveApplies &&
              native.element &&
              isDestructiveTarget({ ...native.element, label: clipValue(native.element.label) })
            ) {
              return refused(
                computerUseError(
                  fresh._tag === "Shot" ? "CU-CON-007" : "CU-CON-003",
                  "The target now looks destructive; look again and request approval.",
                  "not-dispatched",
                ),
              );
            }
          }
          return undefined;
        });
      const refusal = yield* check();
      if (refusal) return refusal;
      const decide = (
        native: DriverDispatchTarget,
        phase: DriverDispatchPhase,
      ): Effect.Effect<DriverDispatchDecision> => {
        const verdict = (response: ComputerUseResponse | undefined) =>
          response && !response.ok ? response.error : undefined;
        if (phase === "prepare") {
          return check(native).pipe(
            Effect.map((response): DriverDispatchDecision => {
              const error = verdict(response);
              return error ? { allowed: false, error } : { allowed: true, release: Effect.void };
            }),
          );
        }
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(dispatchLock.take(1));
            const error = verdict(
              yield* check(native).pipe(Effect.onError(() => dispatchLock.release(1))),
            );
            if (error) {
              yield* dispatchLock.release(1);
              return { allowed: false, error } satisfies DriverDispatchDecision;
            }
            let released = false;
            const release = Effect.suspend(() => {
              if (released) return Effect.void;
              released = true;
              return dispatchLock.release(1).pipe(Effect.asVoid);
            });
            return { allowed: true, release } satisfies DriverDispatchDecision;
          }),
        );
      };
      return yield* dispatchInput(request, resolved).pipe(
        Effect.provideService(ComputerDriverDispatchCheck, decide),
        Effect.as(undefined),
        Effect.catchTag("ComputerDriverError", (error) =>
          Effect.succeed(inputFailure(caller, resolved, error)),
        ),
      );
    });

  const input = (caller: ComputerUseCaller, request: ComputerUseInputRequest) =>
    Effect.gen(function* () {
      const turn = yield* runningTurn(caller);
      if (!turn) {
        return noTurn(
          "No turn is running in this thread; computer actions only happen while you are working on the user's request.",
          "CU-CON-006",
        );
      }
      // Read with the turn, before the hit test; the final check reads it again.
      const approvals = yield* currentApprovals;
      if (yield* approvalPending) return inputPaused;
      const resolved = resolveInputTarget(caller, request);
      if ("ok" in resolved) return resolved;
      const hit = yield* hitFor(request, resolved);
      const destructive =
        resolved._tag === "Element"
          ? isDestructiveTarget(resolved.ref)
          : request.command === "key"
            ? isDestructiveChord(request.keys)
            : request.command === "click" && hit != null && isDestructiveTarget(hit);
      const granted = turn.fullAccess || turnGrants.get(caller.threadId) === turn.turnId;
      const asked = inputNeedsApproval(approvals, { destructive, granted });
      if (asked) {
        const decision = yield* askUser({
          caller,
          turn,
          destructive,
          detail: describeInputForApproval(request, {
            app: resolved.window.app,
            windowTitle: resolved.window.title,
            ...(resolved._tag === "Element" ? { element: resolved.ref } : {}),
            ...(hit !== undefined ? { hit } : {}),
          }),
        });
        if (decision === "paused") return inputPaused;
        if (decision === "decline" || decision === "cancel") {
          return refused(
            computerUseError(
              "CU-CON-004",
              "The user declined this action, or no answer arrived.",
              "not-dispatched",
            ),
          );
        }
        if (!destructive && (decision === "acceptForSession" || decision === "acceptAlways")) {
          turnGrants.set(caller.threadId, turn.turnId);
        }
      }
      const refusal = yield* checkAndDispatch(caller, request, turn, resolved, asked, destructive);
      if (refusal) return refusal;
      const after = yield* afterAction(caller, resolved.window);
      return ok({ kind: "input", effect: "dispatched", ...(after ? { screenshot: after } : {}) });
    });

  const run = (caller: ComputerUseCaller, request: ComputerUseRequest, mode: ComputerUseMode) => {
    if (isInputRequest(request)) {
      return mode === "control"
        ? input(caller, request)
        : Effect.succeed(
            refused(
              computerUseError(
                "CU-CON-002",
                "Computer use is set to observe only; input actions are unavailable. Ask the user to switch it to control in ViewCode settings.",
                "not-dispatched",
              ),
            ),
          );
    }
    switch (request.command) {
      case "status":
        return status.pipe(Effect.map((value) => ok({ kind: "status", status: value })));
      case "list-windows":
        return listWindows(caller, request.app);
      case "observe":
        return observe(caller, request.window, request.query);
      case "screenshot":
        return screenshot(caller, request.window, request.maxSize);
    }
  };

  const internalError = (caller: ComputerUseCaller, cause: Cause.Cause<unknown>) =>
    // The tag only: platform errors carry paths, and payloads may carry text.
    Effect.logWarning("computer use request failed", {
      threadId: caller.threadId,
      errorTag: causeErrorTag(cause),
    }).pipe(
      Effect.as(
        refused(
          computerUseError("CU-INT-001", "ViewCode hit an internal error running this command."),
        ),
      ),
    );

  const handle: ComputerUseServiceShape["handle"] = (caller, body) =>
    Effect.gen(function* () {
      const mode = yield* currentMode;
      if (mode === "off") {
        const response = refused(
          computerUseError("CU-CON-001", "Computer use is turned off in ViewCode settings."),
        );
        yield* logOutcome(caller, undefined, response);
        return response;
      }
      const validated = validateComputerUseRequest(body);
      if (!validated.ok) {
        const response = refused(validated.error);
        yield* logOutcome(caller, undefined, response);
        return response;
      }
      const response = yield* run(caller, validated.request, mode);
      yield* logOutcome(caller, validated.request, response);
      return response;
    }).pipe(
      Effect.catch((error) => internalError(caller, Cause.fail(error))),
      Effect.catchDefect((defect) => internalError(caller, Cause.die(defect))),
    );

  const status: ComputerUseServiceShape["status"] = Effect.gen(function* () {
    const mode = yield* currentMode;
    const driverStatus = yield* driver.status();
    return {
      mode,
      platform,
      driverAvailable: driverStatus.available,
      accessibility: driverStatus.accessibility,
      ...(driverStatus.reason ? { reason: driverStatus.reason } : {}),
    };
  });

  const cancelPending = (predicate: (entry: PendingApproval) => boolean) =>
    Effect.forEach(
      [...pending].filter(([, entry]) => predicate(entry)).map(([requestId]) => requestId),
      (requestId) => settle(requestId, "cancel"),
      { discard: true },
    );

  return ComputerUseService.of({
    handle,
    status,
    trackProviderApproval: (event) => {
      if (!event.requestId || event.requestId.startsWith(REQUEST_ID_PREFIX)) return Effect.void;
      const key = `${event.threadId}:${event.requestId}`;
      // Every request clients render as an approval card (the projection's
      // rule): only user-input questions are not.
      if (event.type === "request.opened" && event.payload.requestType !== "tool_user_input") {
        return dispatchLock.withPermits(1)(
          Effect.sync(() => {
            liveProviderApprovals.set(key, { threadId: event.threadId, turnId: event.turnId });
          }),
        );
      }
      return event.type === "request.resolved"
        ? Effect.sync(() => {
            liveProviderApprovals.delete(key);
          })
        : Effect.void;
    },
    attachRuntimeEventPublisher: (publishEvent) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          publisher = publishEvent;
        }),
        () =>
          Effect.sync(() => {
            if (publisher === publishEvent) publisher = undefined;
          }),
      ),
    respondToApproval: ({ threadId, requestId, decision }) =>
      Effect.gen(function* () {
        if (!requestId.startsWith(REQUEST_ID_PREFIX)) return "not-owned";
        const entry = pending.get(requestId);
        if (!entry || entry.threadId !== threadId) return "stale";
        yield* settle(requestId, decision);
        return "handled";
      }),
    endTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        // No id (an interrupt): the turn the projection shows as running.
        const ended =
          turnId ??
          (yield* projection.getThreadShellById(threadId).pipe(
            Effect.map((thread) => Option.getOrUndefined(thread)?.session?.activeTurnId),
            Effect.orElseSucceed(() => undefined),
          )) ??
          lastRunningTurn.get(threadId);
        if (ended) endedTurns.set(threadId, ended);
        // A provider request still tracked for an ended turn will never be answered.
        for (const [key, owner] of liveProviderApprovals)
          if (
            owner.threadId === threadId &&
            (turnId === undefined || owner.turnId === undefined || owner.turnId === turnId)
          )
            liveProviderApprovals.delete(key);
        if (turnId === undefined || turnGrants.get(threadId) === turnId)
          turnGrants.delete(threadId);
        yield* cancelPending(
          (entry) =>
            entry.threadId === threadId && (turnId === undefined || entry.turnId === turnId),
        );
      }),
    releaseThread: (threadId) =>
      Effect.gen(function* () {
        for (const [key, owner] of liveProviderApprovals)
          if (owner.threadId === threadId) liveProviderApprovals.delete(key);
        targetsByThread.get(threadId)?.reset();
        turnGrants.delete(threadId);
        yield* cancelPending((entry) => entry.threadId === threadId);
      }),
    releaseAll: Effect.gen(function* () {
      liveProviderApprovals.clear();
      for (const targets of targetsByThread.values()) targets.reset();
      turnGrants.clear();
      yield* cancelPending(() => true);
    }),
  });
});

export const layer = Layer.effect(ComputerUseService, make);
