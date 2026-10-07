// @effect-diagnostics nodeBuiltinImport:off - exercises the IPC client with a synthetic worker.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  RuntimeRequestId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ComputerUseMode,
  type ComputerUseRect,
  type ComputerUseResponse,
  type OrchestrationThreadShell,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerDriver,
  ComputerDriverDispatchCheck,
  ComputerDriverError,
  type ComputerDriverShape,
  type DriverElement,
  type DriverElementIdentity,
  type DriverWindow,
} from "./ComputerDriver.ts";
import { ServerProcessAncestry } from "./computerUseAncestry.ts";
import * as ComputerUseService from "./ComputerUseService.ts";
import { makeXa11yComputerDriver } from "./Xa11yComputerDriver.ts";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const NOW = "2026-10-06T00:00:00.000Z";
const threadId = ThreadId.make("thread-computer-use");
const providerInstanceId = ProviderInstanceId.make("codex");
const caller = { threadId, providerInstanceId };

const notes: DriverWindow = {
  handle: "w-notes",
  app: "Notes",
  pid: 10,
  title: "Shopping list",
  focused: true,
  appIdentifier: "/System/Applications/Notes.app/Contents/MacOS/Notes",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};
const onePassword: DriverWindow = {
  handle: "w-1p",
  app: "1Password",
  pid: 11,
  title: "Vault",
  focused: false,
  appIdentifier: "/Applications/1Password.app/Contents/MacOS/1Password",
  bounds: { x: 2000, y: 0, width: 400, height: 400 },
};
const viewCode: DriverWindow = {
  handle: "w-vc",
  app: "ViewCode",
  pid: 12,
  title: "Thread",
  focused: false,
  appIdentifier: "/Applications/ViewCode.app/Contents/MacOS/ViewCode",
  bounds: { x: 0, y: 0, width: 1400, height: 900 },
};
const save: DriverElement = {
  handle: "e-save",
  role: "button",
  label: "Save",
  enabled: true,
  focused: false,
};
const remove: DriverElement = {
  handle: "e-delete",
  role: "button",
  label: "Delete note",
  enabled: true,
  focused: false,
};
const field: DriverElement = {
  handle: "e-field",
  role: "text field",
  label: "Title",
  enabled: true,
  focused: false,
};

interface Harness {
  readonly service: ComputerUseService.ComputerUseServiceShape;
  /** Driver calls in order, as `method:handle`. */
  readonly calls: Array<string>;
  readonly events: Array<ProviderRuntimeEvent>;
  /** `request.opened` events nobody auto-answered. */
  readonly openedApprovals: Queue.Queue<ProviderRuntimeEvent>;
  readonly setMode: (mode: ComputerUseMode) => Effect.Effect<void>;
  readonly thread: {
    running: boolean;
    turnId: TurnId;
    runtimeMode: RuntimeMode;
  };
  /** When set, approvals are answered with this as soon as they open. */
  autoDecision: ProviderApprovalDecision | undefined;
  failNext: ComputerDriverError | undefined;
  /** What `elementAt` reports under any point. */
  hit: DriverElementIdentity | null;
  /** Makes every screenshot fail with this. */
  screenshotFailure: ComputerDriverError | undefined;
  /** `expectBounds` of the last coordinate call. */
  readonly lastBounds: () => ComputerUseRect | undefined;
  /** What `listWindows` returns; handles missing from it read as stale. */
  windows: Array<DriverWindow>;
  /** A provider approval waiting somewhere in the environment. */
  providerApprovalPending: boolean;
  /** Pids treated as the server's own process ancestry. */
  readonly ancestry: Set<number>;
  /** When set, `elementAt` signals `entered` and waits for `release`. */
  elementAtGate:
    | { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
    | undefined;
  /** What `observe` returns. */
  elements: Array<DriverElement>;
  /** The live element the driver reports at dispatch, by handle; defaults to the observed one. */
  readonly native: Map<string, DriverElementIdentity>;
  /** Makes `listWindows` fail with this. */
  listFailure: ComputerDriverError | undefined;
  /** Runs inside `screenshot`, as the capture happens. */
  duringCapture: ((outputPath: string) => void) | undefined;
}

/** A 1568×980 image of a 784×490-point window at (100, 50): half a point per pixel. */
const SHOT_BOUNDS: ComputerUseRect = { x: 100, y: 50, width: 784, height: 490 };

const makeHarness = (
  initialMode: ComputerUseMode = "control",
  override?: (driver: ComputerDriverShape) => ComputerDriverShape,
) =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const events: Array<ProviderRuntimeEvent> = [];
    const openedApprovals = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const thread: Harness["thread"] = {
      running: true,
      turnId: TurnId.make("turn-1"),
      runtimeMode: "approval-required",
    };
    const state = {
      autoDecision: undefined as ProviderApprovalDecision | undefined,
      failNext: undefined as ComputerDriverError | undefined,
      hit: null as DriverElementIdentity | null,
      screenshotFailure: undefined as ComputerDriverError | undefined,
      lastBounds: undefined as ComputerUseRect | undefined,
      windows: [notes, onePassword, viewCode] as Array<DriverWindow>,
      providerApprovalPending: false,
      elementAtGate: undefined as Harness["elementAtGate"],
      elements: [save, remove, field] as Array<DriverElement>,
      listFailure: undefined as ComputerDriverError | undefined,
      duringCapture: undefined as Harness["duringCapture"],
    };
    const native = new Map<string, DriverElementIdentity>();
    const ancestry = new Set<number>();
    const staleUnlessListed = (handle: string) =>
      state.windows.some((window) => window.handle === handle)
        ? undefined
        : new ComputerDriverError({ kind: "stale", message: "Unknown window.", dispatched: "no" });
    const pointer =
      (name: string) =>
      (
        handle: string,
        bounds: ComputerUseRect,
        ...points: ReadonlyArray<{ readonly x: number; readonly y: number }>
      ) => {
        state.lastBounds = bounds;
        return action(`${name}:${points.map(({ x, y }) => `${x},${y}`).join(">")}`)(handle);
      };

    /** Like the worker: asks the server's dispatch check for the native target first. */
    const action =
      (name: string) =>
      (handle: string): Effect.Effect<void, ComputerDriverError> =>
        Effect.gen(function* () {
          const window = state.windows.find((entry) => entry.handle === handle) ?? notes;
          const observed = state.elements.find((entry) => entry.handle === handle);
          const element =
            native.get(handle) ??
            (observed ? { role: observed.role, label: observed.label } : state.hit);
          const check = yield* ComputerDriverDispatchCheck;
          const decision = yield* check({ window, ...(element ? { element } : {}) }, "dispatch");
          if (!decision.allowed) {
            return yield* new ComputerDriverError({
              kind: "policy",
              code: decision.error.code,
              message: decision.error.message,
              dispatched: "no",
            });
          }
          calls.push(`${name}:${handle}`);
          const failure = state.failNext;
          state.failNext = undefined;
          yield* decision.release;
          if (failure) return yield* failure;
        });
    const driver: ComputerDriverShape = {
      status: () => Effect.succeed({ available: true, accessibility: "granted" }),
      listWindows: () =>
        Effect.suspend(() => {
          calls.push("listWindows");
          return state.listFailure ? Effect.fail(state.listFailure) : Effect.succeed(state.windows);
        }),
      observe: (handle) =>
        Effect.suspend(() => {
          calls.push(`observe:${handle}`);
          const failure = state.failNext ?? staleUnlessListed(handle);
          state.failNext = undefined;
          return failure
            ? Effect.fail(failure)
            : Effect.succeed({ elements: state.elements, truncated: false });
        }),
      screenshot: (handle, outputPath) =>
        Effect.suspend(() => {
          calls.push(`screenshot:${handle}`);
          state.duringCapture?.(outputPath);
          return state.screenshotFailure
            ? Effect.fail(state.screenshotFailure)
            : Effect.succeed({ width: 1568, height: 980, bounds: SHOT_BOUNDS });
        }),
      elementAt: (handle) =>
        Effect.gen(function* () {
          calls.push(`elementAt:${handle}`);
          const gate = state.elementAtGate;
          if (gate) {
            yield* Deferred.succeed(gate.entered, undefined);
            yield* Deferred.await(gate.release);
          }
          return state.hit;
        }),
      click: (handle, bounds, point, options) =>
        pointer(`click(${options.button}x${options.count})`)(handle, bounds, point),
      drag: (handle, bounds, from, to) => pointer("drag")(handle, bounds, from, to),
      move: (handle, bounds, point) => pointer("move")(handle, bounds, point),
      scrollAt: (handle, bounds, point) => pointer("scrollAt")(handle, bounds, point),
      typeFocused: (handle) => action("typeFocused")(handle),
      press: (handle) => action("press")(handle),
      setValue: (handle) => action("setValue")(handle),
      typeText: (handle) => action("typeText")(handle),
      key: (handle) => action("key")(handle),
      scroll: (handle) => action("scroll")(handle),
    };

    const shell = (): OrchestrationThreadShell => ({
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: thread.runtimeMode,
      interactionMode: "default",
      pullRequests: [],
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: {
        threadId,
        status: thread.running ? "running" : "ready",
        providerName: "codex",
        providerInstanceId,
        runtimeMode: thread.runtimeMode,
        activeTurnId: thread.running ? thread.turnId : null,
        lastError: null,
        updatedAt: NOW,
      },
      latestUserMessageAt: NOW,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    const layer = ComputerUseService.layer.pipe(
      Layer.provideMerge(ServerSettings.layerTest({ computerUse: initialMode })),
      Layer.provide(Layer.succeed(ComputerDriver, override ? override(driver) : driver)),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.some(shell())),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-use-test-" })),
      Layer.provide(Layer.succeed(ComputerUseService.ComputerUseSettleDelay, Duration.zero)),
      Layer.provide(
        Layer.succeed(ComputerUseService.ComputerUsePendingApprovals, {
          anyPending: Effect.sync(() => state.providerApprovalPending),
        }),
      ),
      Layer.provide(Layer.succeed(ServerProcessAncestry, ancestry)),
      Layer.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(layer);
    const service = Context.get(context, ComputerUseService.ComputerUseService);
    const settings = Context.get(context, ServerSettings.ServerSettingsService);

    const harness: Harness = {
      service,
      calls,
      events,
      openedApprovals,
      thread,
      setMode: (mode) =>
        settings.updateSettings({ computerUse: mode }).pipe(Effect.orDie, Effect.asVoid),
      get autoDecision() {
        return state.autoDecision;
      },
      set autoDecision(value) {
        state.autoDecision = value;
      },
      get failNext() {
        return state.failNext;
      },
      set failNext(value) {
        state.failNext = value;
      },
      get hit() {
        return state.hit;
      },
      set hit(value) {
        state.hit = value;
      },
      get screenshotFailure() {
        return state.screenshotFailure;
      },
      set screenshotFailure(value) {
        state.screenshotFailure = value;
      },
      lastBounds: () => state.lastBounds,
      ancestry,
      get windows() {
        return state.windows;
      },
      set windows(value) {
        state.windows = value;
      },
      get providerApprovalPending() {
        return state.providerApprovalPending;
      },
      set providerApprovalPending(value) {
        state.providerApprovalPending = value;
      },
      get elementAtGate() {
        return state.elementAtGate;
      },
      set elementAtGate(value) {
        state.elementAtGate = value;
      },
      get elements() {
        return state.elements;
      },
      set elements(value) {
        state.elements = value;
      },
      native,
      get listFailure() {
        return state.listFailure;
      },
      set listFailure(value) {
        state.listFailure = value;
      },
      get duringCapture() {
        return state.duringCapture;
      },
      set duringCapture(value) {
        state.duringCapture = value;
      },
    };

    yield* service.attachRuntimeEventPublisher((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type !== "request.opened" || !event.requestId) return;
        const decision = state.autoDecision;
        if (decision) {
          yield* service.respondToApproval({ threadId, requestId: event.requestId, decision });
        } else {
          yield* Queue.offer(openedApprovals, event);
        }
      }),
    );
    return harness;
  });

const send = (harness: Harness, body: unknown) => harness.service.handle(caller, body);

const expectError = (response: ComputerUseResponse, code: string, effect?: string) => {
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe(code);
  if (effect !== undefined) expect(response.error.effect).toBe(effect);
};

const expectDispatched = (response: ComputerUseResponse) =>
  expect(response).toMatchObject({ ok: true, result: { kind: "input", effect: "dispatched" } });

/** Lists windows and observes Notes; returns the refs for Save, Delete note and Title. */
const observeNotes = (harness: Harness) =>
  Effect.gen(function* () {
    const listed = yield* send(harness, { command: "list-windows" });
    if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
    const window = listed.result.windows.find((entry) => entry.app === "Notes")!.id;
    const observed = yield* send(harness, { command: "observe", window });
    if (!observed.ok || observed.result.kind !== "observation") throw new Error("observe failed");
    const [saveRef, deleteRef, fieldRef] = observed.result.elements.map((element) => element.ref);
    return { window, save: saveRef!, delete: deleteRef!, field: fieldRef! };
  });

/** Calls that act on the desktop (not listing, reading or capturing). */
const inputCalls = (harness: Harness) =>
  harness.calls.filter((call) => !/^(listWindows|observe|screenshot|elementAt)/.test(call));

describe("ComputerUseService modes", () => {
  it.effect("refuses every command while computer use is off and never reaches the driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("off");
      for (const body of [
        { command: "status" },
        { command: "list-windows" },
        { command: "observe", window: 1 },
        { command: "press", ref: 1 },
      ]) {
        expectError(yield* send(harness, body), "CU-CON-001");
      }
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("observe mode refuses input without reaching the driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("control");
      const refs = yield* observeNotes(harness);
      yield* harness.setMode("observe");
      expectError(
        yield* send(harness, { command: "press", ref: refs.save }),
        "CU-CON-002",
        "not-dispatched",
      );
      expectError(
        yield* send(harness, { command: "key", window: refs.window, keys: "enter" }),
        "CU-CON-002",
        "not-dispatched",
      );
      expect(inputCalls(harness)).toEqual([]);
      // Observation still works in observe mode.
      expect((yield* send(harness, { command: "observe", window: refs.window })).ok).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("input without a running turn is refused before the driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(harness);
      harness.thread.running = false;
      expectError(
        yield* send(harness, { command: "press", ref: refs.save }),
        "CU-CON-006",
        "not-dispatched",
      );
      expect(inputCalls(harness)).toEqual([]);
      expect(harness.events).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("ComputerUseService approvals", () => {
  it.effect("holds input behind an approval until the user accepts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      const pending = yield* send(harness, { command: "press", ref: refs.save }).pipe(
        Effect.forkChild,
      );
      const opened = yield* Queue.take(harness.openedApprovals);
      expect(inputCalls(harness)).toEqual([]);
      if (opened.type !== "request.opened") throw new Error("expected request.opened");
      expect(opened.turnId).toBe("turn-1");
      expect(opened.providerInstanceId).toBe(providerInstanceId);
      expect(opened.payload.requestType).toBe("permission_approval");
      expect(opened.payload.appName).toBe("Computer use");
      expect(opened.payload.detail).toContain('button "Save"');
      expect(opened.payload.detail).toContain("Notes");
      expect(
        yield* harness.service.respondToApproval({
          threadId,
          requestId: opened.requestId!,
          decision: "accept",
        }),
      ).toBe("handled");
      expectDispatched(yield* Fiber.join(pending));
      expect(inputCalls(harness)).toEqual(["press:e-save"]);
      expect(harness.events.map((event) => event.type)).toEqual([
        "request.opened",
        "request.resolved",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("a declined approval is not dispatched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      harness.autoDecision = "decline";
      expectError(
        yield* send(harness, { command: "press", ref: refs.save }),
        "CU-CON-004",
        "not-dispatched",
      );
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("accept for the turn covers routine input until the turn ends", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      harness.autoDecision = "acceptForSession";
      expectDispatched(yield* send(harness, { command: "press", ref: refs.save }));
      // Any further question would now be declined, so success means no question.
      harness.autoDecision = "decline";
      expectDispatched(yield* send(harness, { command: "scroll", ref: refs.save, dx: 0, dy: 3 }));
      expect(harness.events.filter((event) => event.type === "request.opened")).toHaveLength(1);

      yield* harness.service.endTurn(threadId, harness.thread.turnId);
      harness.thread.turnId = TurnId.make("turn-2");
      expectError(yield* send(harness, { command: "press", ref: refs.save }), "CU-CON-004");
      expect(inputCalls(harness)).toEqual(["press:e-save", "scroll:e-save"]);
    }).pipe(Effect.scoped),
  );

  it.effect("destructive targets ask even under a turn grant", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      harness.autoDecision = "acceptForSession";
      expectDispatched(yield* send(harness, { command: "press", ref: refs.save }));
      harness.autoDecision = "decline";
      expectError(yield* send(harness, { command: "press", ref: refs.delete }), "CU-CON-004");
      expect(inputCalls(harness)).toEqual(["press:e-save"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "full access runs routine input without asking but still asks for destructive ones",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.thread.runtimeMode = "full-access";
        const refs = yield* observeNotes(harness);
        harness.autoDecision = "decline";
        expectDispatched(yield* send(harness, { command: "press", ref: refs.save }));
        expect(harness.events).toEqual([]);

        expectError(yield* send(harness, { command: "press", ref: refs.delete }), "CU-CON-004");
        expectError(
          yield* send(harness, { command: "key", window: refs.window, keys: "cmd+q" }),
          "CU-CON-004",
        );
        const opened = harness.events.filter((event) => event.type === "request.opened");
        expect(opened).toHaveLength(2);
        expect(inputCalls(harness)).toEqual(["press:e-save"]);
      }).pipe(Effect.scoped),
  );

  it.effect("approval text counts typed characters and never shows them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      harness.autoDecision = "decline";
      yield* send(harness, { command: "type", ref: refs.field, text: "hunter2-secret" });
      const opened = harness.events.find((event) => event.type === "request.opened");
      if (opened?.type !== "request.opened") throw new Error("expected an approval");
      expect(opened.payload.detail).toContain("14 characters");
      expect(opened.payload.detail).not.toContain("hunter2");
    }).pipe(Effect.scoped),
  );

  it.effect("ending the turn cancels a pending approval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refs = yield* observeNotes(harness);
      const pending = yield* send(harness, { command: "press", ref: refs.save }).pipe(
        Effect.forkChild,
      );
      yield* Queue.take(harness.openedApprovals);
      yield* harness.service.endTurn(threadId);
      expectError(yield* Fiber.join(pending), "CU-CON-004", "not-dispatched");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("tells ProviderService which request ids it owns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.service.respondToApproval({
          threadId,
          requestId: "computer-use:gone",
          decision: "accept",
        }),
      ).toBe("stale");
      expect(
        yield* harness.service.respondToApproval({
          threadId,
          requestId: "codex-approval-1",
          decision: "accept",
        }),
      ).toBe("not-owned");
    }).pipe(Effect.scoped),
  );
});

describe("ComputerUseService targets", () => {
  it.effect("fabricated window ids and refs never reach the driver", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(harness);
      expectError(yield* send(harness, { command: "observe", window: 999 }), "CU-NOT-001");
      expectError(
        yield* send(harness, { command: "key", window: 999, keys: "enter" }),
        "CU-NOT-001",
      );
      expectError(
        yield* send(harness, { command: "press", ref: 999 }),
        "CU-NOT-002",
        "not-dispatched",
      );
      expect(harness.calls).toEqual(["listWindows", "listWindows", `observe:${notes.handle}`]);
      expect(refs.save).toBeGreaterThan(0);
    }).pipe(Effect.scoped),
  );

  it.effect("refs from an older observation and stale elements are refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const first = yield* observeNotes(harness);
      const second = yield* send(harness, { command: "observe", window: first.window });
      if (!second.ok || second.result.kind !== "observation") throw new Error("observe failed");
      expect(second.result.elements[0]!.ref).not.toBe(first.save);
      expectError(
        yield* send(harness, { command: "press", ref: first.save }),
        "CU-CON-003",
        "not-dispatched",
      );
      expect(inputCalls(harness)).toEqual([]);

      harness.failNext = new ComputerDriverError({
        kind: "stale",
        message: "gone",
        dispatched: "no",
      });
      expectError(
        yield* send(harness, { command: "press", ref: second.result.elements[0]!.ref }),
        "CU-CON-003",
        "not-dispatched",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("denylisted apps are listed but never observed or controlled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const listed = yield* send(harness, { command: "list-windows" });
      if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
      const byApp = new Map(listed.result.windows.map((window) => [window.app, window.id]));
      expect([...byApp.keys()]).toEqual(["Notes", "1Password", "ViewCode"]);
      for (const app of ["1Password", "ViewCode"]) {
        const window = byApp.get(app)!;
        expectError(yield* send(harness, { command: "observe", window }), "CU-CON-005");
        expectError(yield* send(harness, { command: "screenshot", window }), "CU-CON-005");
        expectError(
          yield* send(harness, { command: "key", window, keys: "enter" }),
          "CU-CON-005",
          "not-dispatched",
        );
      }
      expect(harness.calls).toEqual(["listWindows"]);
    }).pipe(Effect.scoped),
  );

  it.effect("an input the driver may have delivered reports dispatched-unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(harness);
      harness.failNext = new ComputerDriverError({
        kind: "timeout",
        message: "The driver did not answer.",
        dispatched: "unknown",
      });
      expectError(
        yield* send(harness, { command: "press", ref: refs.save }),
        "CU-EXT-004",
        "dispatched-unknown",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("stopping the session forgets windows and refs without reusing numbers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const before = yield* observeNotes(harness);
      yield* harness.service.releaseThread(threadId);
      expectError(yield* send(harness, { command: "press", ref: before.save }), "CU-CON-003");
      expectError(
        yield* send(harness, { command: "observe", window: before.window }),
        "CU-NOT-001",
      );
      const after = yield* observeNotes(harness);
      expect(after.window).toBeGreaterThan(before.window);
      expect(after.save).toBeGreaterThan(before.field);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects malformed requests with the matching validation code", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expectError(yield* send(harness, { command: "tap" }), "CU-VAL-001");
      expectError(yield* send(harness, { command: "press" }), "CU-VAL-002");
      expectError(yield* send(harness, { command: "press", ref: "one" }), "CU-VAL-003");
      expectError(
        yield* send(harness, { command: "press", ref: 1, threadId: "other" }),
        "CU-VAL-004",
      );
      expect(harness.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

/** Lists windows and screenshots Notes; returns the window id and the shot. */
const shootNotes = (harness: Harness) =>
  Effect.gen(function* () {
    const listed = yield* send(harness, { command: "list-windows" });
    if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
    const window = listed.result.windows.find((entry) => entry.app === "Notes")!.id;
    const shot = yield* send(harness, { command: "screenshot", window });
    if (!shot.ok || shot.result.kind !== "screenshot") throw new Error("screenshot failed");
    return { window, shot: shot.result.shot };
  });

describe("ComputerUseService coordinates", () => {
  it.effect("maps image pixels to screen points through the shot's bounds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(harness);
      expectDispatched(yield* send(harness, { command: "click", shot, x: 100, y: 200 }));
      // 100.5 px × 0.5 pt/px + 100 = 150.25; 200.5 px × 0.5 + 50 = 150.25.
      expect(inputCalls(harness)).toEqual([`click(leftx1):150.25,150.25:${notes.handle}`]);
      expect(harness.lastBounds()).toEqual(SHOT_BOUNDS);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses unknown shots, older shots and pixels outside the image before the driver",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        harness.thread.runtimeMode = "full-access";
        const first = yield* shootNotes(harness);
        const second = yield* send(harness, { command: "screenshot", window: first.window });
        if (!second.ok || second.result.kind !== "screenshot") throw new Error("screenshot failed");
        const callsBefore = harness.calls.length;
        expectError(
          yield* send(harness, { command: "click", shot: 999, x: 1, y: 1 }),
          "CU-NOT-003",
          "not-dispatched",
        );
        expectError(
          yield* send(harness, { command: "click", shot: first.shot, x: 1, y: 1 }),
          "CU-CON-007",
          "not-dispatched",
        );
        expectError(
          yield* send(harness, { command: "click", shot: second.result.shot, x: 1568, y: 1 }),
          "CU-VAL-003",
          "not-dispatched",
        );
        expect(harness.calls.length).toBe(callsBefore);
      }).pipe(Effect.scoped),
  );

  it.effect("names what the point hits and always asks before clicking something destructive", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(harness);
      harness.hit = { role: "button", label: "Delete" };
      harness.autoDecision = "decline";
      expectError(yield* send(harness, { command: "click", shot, x: 10, y: 10 }), "CU-CON-004");
      const opened = harness.events.find((event) => event.type === "request.opened");
      if (opened?.type !== "request.opened") throw new Error("expected an approval");
      expect(opened.payload.detail).toContain('Click at (10, 10) in Notes — "Shopping list"');
      expect(opened.payload.detail).toContain('on button "Delete"');
      expect(opened.payload.detail).toContain("brings the window to the front");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("returns a fresh screenshot after input, which becomes the newest shot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(harness);
      const response = yield* send(harness, { command: "click", shot, x: 1, y: 1 });
      if (!response.ok || response.result.kind !== "input") throw new Error("click failed");
      const next = response.result.screenshot;
      expect(next?.shot).toBeGreaterThan(shot);
      expect(next?.width).toBe(1568);
      expectError(yield* send(harness, { command: "move", shot, x: 1, y: 1 }), "CU-CON-007");
      expectDispatched(yield* send(harness, { command: "move", shot: next!.shot, x: 1, y: 1 }));
    }).pipe(Effect.scoped),
  );

  it.effect("still reports the action when the follow-up screenshot cannot be taken", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(harness);
      harness.screenshotFailure = new ComputerDriverError({
        kind: "permission-screen",
        message: "Screen Recording is off.",
        dispatched: "no",
      });
      expect(yield* send(harness, { command: "click", shot, x: 1, y: 1 })).toEqual({
        ok: true,
        result: { kind: "input", effect: "dispatched" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("a window that moved since the shot is refused as CU-CON-007", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(harness);
      harness.failNext = new ComputerDriverError({
        kind: "stale",
        message: "Window moved.",
        dispatched: "no",
      });
      expectError(
        yield* send(harness, { command: "click", shot, x: 1, y: 1 }),
        "CU-CON-007",
        "not-dispatched",
      );
    }).pipe(Effect.scoped),
  );
});

describe("ComputerUseService input pause", () => {
  it.effect("refuses all input while a provider approval waits, but keeps observing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(harness);
      harness.providerApprovalPending = true;
      expectError(
        yield* send(harness, { command: "press", ref: refs.save }),
        "CU-CON-008",
        "not-dispatched",
      );
      expect((yield* send(harness, { command: "observe", window: refs.window })).ok).toBe(true);
      // Refused up front: no approval card opens on top of the waiting one.
      harness.thread.runtimeMode = "approval-required";
      harness.autoDecision = "accept";
      expectError(yield* send(harness, { command: "press", ref: refs.save }), "CU-CON-008");
      expect(harness.events).toEqual([]);
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "pauses other input while a computer-use approval waits, then runs the approved one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const refs = yield* observeNotes(harness);
        const pending = yield* send(harness, { command: "press", ref: refs.save }).pipe(
          Effect.forkChild,
        );
        const opened = yield* Queue.take(harness.openedApprovals);
        // Even full access waits: nothing may run while a card is on screen.
        harness.thread.runtimeMode = "full-access";
        expectError(
          yield* send(harness, { command: "scroll", ref: refs.save, dx: 0, dy: 1 }),
          "CU-CON-008",
        );
        yield* harness.service.respondToApproval({
          threadId,
          requestId: opened.requestId!,
          decision: "accept",
        });
        expectDispatched(yield* Fiber.join(pending));
        expect(inputCalls(harness)).toEqual(["press:e-save"]);
      }).pipe(Effect.scoped),
  );
});

describe("ComputerUseService final checks", () => {
  /** Starts a full-access coordinate click and holds it inside the hit test. */
  const heldClick = (harness: Harness) =>
    Effect.gen(function* () {
      harness.thread.runtimeMode = "full-access";
      const { window, shot } = yield* shootNotes(harness);
      const gate = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      harness.elementAtGate = gate;
      const click = yield* send(harness, { command: "click", shot, x: 5, y: 5 }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(gate.entered);
      harness.elementAtGate = undefined;
      return {
        window,
        finish: Deferred.succeed(gate.release, undefined).pipe(Effect.andThen(Fiber.join(click))),
      };
    });

  it.effect("does not dispatch when computer use is turned down mid-request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const held = yield* heldClick(harness);
      yield* harness.setMode("observe");
      expectError(yield* held.finish, "CU-CON-002", "not-dispatched");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not dispatch when the turn ends mid-request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const held = yield* heldClick(harness);
      harness.thread.running = false;
      expectError(yield* held.finish, "CU-CON-006", "not-dispatched");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not dispatch on a shot superseded mid-request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const held = yield* heldClick(harness);
      expect((yield* send(harness, { command: "screenshot", window: held.window })).ok).toBe(true);
      expectError(yield* held.finish, "CU-CON-007", "not-dispatched");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not dispatch when an approval opens mid-request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const held = yield* heldClick(harness);
      harness.providerApprovalPending = true;
      expectError(yield* held.finish, "CU-CON-008", "not-dispatched");
      expect(inputCalls(harness)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("ComputerUseService identity and overlays", () => {
  it.effect("refuses windows owned by the server's own process ancestry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.ancestry.add(notes.pid);
      const listed = yield* send(harness, { command: "list-windows" });
      if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
      const window = listed.result.windows.find((entry) => entry.app === "Notes")!.id;
      expectError(yield* send(harness, { command: "observe", window }), "CU-CON-005");
      expect(harness.calls).toEqual(["listWindows"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses screenshots under a protected window and omits the post-action one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      harness.thread.runtimeMode = "full-access";
      const { window, shot } = yield* shootNotes(harness);
      harness.windows = [
        notes,
        { ...onePassword, bounds: { x: 700, y: 500, width: 400, height: 400 } },
        viewCode,
      ];
      expectError(yield* send(harness, { command: "screenshot", window }), "CU-CON-005");
      expect(yield* send(harness, { command: "click", shot, x: 1, y: 1 })).toEqual({
        ok: true,
        result: { kind: "input", effect: "dispatched" },
      });
      // ViewCode overlapping is fine: its content is no secret to the agent.
      harness.windows = [notes, onePassword, viewCode];
      expect((yield* send(harness, { command: "screenshot", window })).ok).toBe(true);
      expect(harness.calls.filter((call) => call.startsWith("screenshot:"))).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("a window id from before a driver restart never resolves to a new window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const before = yield* observeNotes(harness);
      // The driver restarts and mints a handle this service has never seen.
      harness.windows = [{ ...notes, handle: "g2:w1", app: "Terminal", pid: 20, title: "zsh" }];
      const other = { threadId: ThreadId.make("thread-other"), providerInstanceId };
      expect((yield* harness.service.handle(other, { command: "list-windows" })).ok).toBe(true);
      expectError(
        yield* send(harness, { command: "observe", window: before.window }),
        "CU-NOT-001",
      );
      const calls = harness.calls.length;
      expectError(
        yield* send(harness, { command: "observe", window: before.window }),
        "CU-NOT-001",
      );
      expect(harness.calls.length).toBe(calls);
      expect(harness.calls).toContain(`observe:${notes.handle}`);
      expect(harness.calls).not.toContain("observe:g2:w1");
    }).pipe(Effect.scoped),
  );
});

describe("Computer use audit regressions", () => {
  it.effect("refuses observing or controlling NordPass", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      h.windows = [
        {
          ...notes,
          app: "NordPass",
          appIdentifier: "/Applications/NordPass.app/Contents/MacOS/NordPass",
        },
      ];
      const listed = yield* send(h, { command: "list-windows" });
      if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
      const window = listed.result.windows[0]!.id;
      expectError(yield* send(h, { command: "observe", window }), "CU-CON-005");
      expectError(yield* send(h, { command: "type-focused", window, text: "audit" }), "CU-CON-005");
    }).pipe(Effect.scoped),
  );
  it.effect("refreshes the browser title before observation and capture", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      h.windows = [{ ...notes, app: "Google Chrome", title: "Documentation" }];
      const listed = yield* send(h, { command: "list-windows" });
      if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
      const window = listed.result.windows[0]!.id;
      h.windows = [{ ...h.windows[0]!, title: "ViewCode" }];
      expectError(yield* send(h, { command: "observe", window }), "CU-CON-005");
      expectError(yield* send(h, { command: "screenshot", window }), "CU-CON-005");
      expectError(yield* send(h, { command: "type-focused", window, text: "audit" }), "CU-CON-005");
    }).pipe(Effect.scoped),
  );
  it.effect("refuses unapproved input after a Full access downgrade during hit-test", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      const shot = yield* send(h, { command: "screenshot", window: refs.window });
      if (!shot.ok || shot.result.kind !== "screenshot") throw new Error("shot failed");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.elementAtGate = { entered, release };
      const action = yield* Effect.forkChild(
        send(h, { command: "click", shot: shot.result.shot, x: 10, y: 10 }),
      );
      yield* Deferred.await(entered);
      h.thread.runtimeMode = "approval-required";
      yield* Deferred.succeed(release, undefined);
      expectError(yield* Fiber.join(action), "CU-CON-004", "not-dispatched");
      expect(h.events.filter((e) => e.type === "request.opened")).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

for (const changed of ["mode", "pending", "turn"] as const) {
  it.effect(`real driver IPC queue rechecks ${changed} before dispatch`, () =>
    Effect.gen(function* () {
      const blocked = Promise.withResolvers<void>();
      const enteredKey = yield* Deferred.make<void>();
      let delivered = false;
      let releaseRead: (() => void) | undefined;
      const server = NodeHttp.createServer((req, res) => {
        if (req.url === "/read") {
          releaseRead = () => res.end("release");
          blocked.resolve();
        } else {
          delivered = true;
          res.end("delivered");
        }
      });
      yield* Effect.promise(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server");
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-audit-worker-"));
      const script = NodePath.join(dir, "worker.cjs");
      NodeFS.writeFileSync(
        script,
        `const http=require('node:http');
const get = path => new Promise(resolve => http.get('http://127.0.0.1:${address.port}'+path, res => {res.resume(); res.on('end',resolve);}));
process.on('message', async message => {
 const {id,request,decision}=message;
 if ('decision' in message) {
  if(decision) process.send({id,ok:false,error:{kind:'policy',code:decision.code,message:decision.message,dispatched:'no'}});
  else {await get('/sent');process.send({id,ok:true,result:null});}
 } else if(request.op==='listWindows') {await get('/read'); process.send({id,ok:true,result:[]});}
 else if(request.op==='key') process.send({id,authorize:{window:{handle:'w-notes',app:'Notes',pid:10,title:'Shopping list',focused:true}}});
}); process.once('disconnect',()=>process.exit(0));`,
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((r) => {
              releaseRead?.();
              server.close(() => r());
              NodeFS.rmSync(dir, { recursive: true, force: true });
            }),
        ),
      );
      const real = yield* makeXa11yComputerDriver({
        platform: "darwin",
        launch: () => ({ command: process.execPath, args: [script], env: { ...process.env } }),
      });
      const h = yield* makeHarness("control", (driver) => ({
        ...driver,
        key: (window, keys) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(enteredKey, undefined);
            return yield* real.key(window, keys);
          }),
      }));
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      const reading = yield* Effect.forkChild(real.listWindows());
      yield* Effect.promise(() => blocked.promise);
      const action = yield* Effect.forkChild(
        send(h, { command: "key", window: refs.window, keys: "enter" }),
      );
      yield* Deferred.await(enteredKey);
      yield* Effect.yieldNow;
      if (changed === "mode") yield* h.setMode("off");
      if (changed === "pending") h.providerApprovalPending = true;
      if (changed === "turn") yield* h.service.endTurn(threadId);
      releaseRead!();

      yield* Fiber.join(reading);
      expectError(
        yield* Fiber.join(action),
        changed === "mode" ? "CU-CON-002" : changed === "pending" ? "CU-CON-008" : "CU-CON-006",
        "not-dispatched",
      );
      expect(delivered).toBe(false);
    }).pipe(Effect.scoped),
  );
}

for (const requestType of [
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "mcp_elicitation_approval",
  "permission_approval",
] as const) {
  it.effect(`${requestType} pauses input before its projection catches up`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      const opened: ProviderRuntimeEvent = {
        eventId: EventId.make("provider-open"),
        type: "request.opened",
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        threadId,
        turnId: h.thread.turnId,
        requestId: RuntimeRequestId.make("provider-approval"),
        createdAt: NOW,
        payload: { requestType },
      };
      yield* h.service.trackProviderApproval(opened);
      expectError(
        yield* send(h, { command: "press", ref: refs.save }),
        "CU-CON-008",
        "not-dispatched",
      );
      yield* h.service.trackProviderApproval({
        ...opened,
        eventId: EventId.make("provider-resolved"),
        type: "request.resolved",
        payload: { requestType, decision: "decline" },
      });
      expectDispatched(yield* send(h, { command: "press", ref: refs.save }));
    }).pipe(Effect.scoped),
  );
}

it.effect("a failed approval publication does not leave input permanently paused", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const refs = yield* observeNotes(h);
    yield* h.service.attachRuntimeEventPublisher((event) =>
      event.type === "request.opened"
        ? Effect.die(new Error("synthetic publication failure"))
        : Effect.void,
    );
    expectError(yield* send(h, { command: "press", ref: refs.save }), "CU-INT-001");
    h.thread.runtimeMode = "full-access";
    expectDispatched(yield* send(h, { command: "press", ref: refs.save }));
  }).pipe(Effect.scoped),
);

const providerRequest = (
  harness: Harness,
  requestType: "tool_user_input" | "command_execution_approval",
  id: string,
): ProviderRuntimeEvent => ({
  eventId: EventId.make(`${id}-open`),
  type: "request.opened",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId,
  threadId,
  turnId: harness.thread.turnId,
  requestId: RuntimeRequestId.make(id),
  createdAt: NOW,
  payload: { requestType },
});

describe("Computer use review regressions", () => {
  it.effect("every provider approval pauses input until answered or its turn ends", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      // A question for the user is not an approval card.
      yield* h.service.trackProviderApproval(providerRequest(h, "tool_user_input", "question"));
      expectDispatched(yield* send(h, { command: "press", ref: refs.save }));
      yield* h.service.trackProviderApproval(
        providerRequest(h, "command_execution_approval", "command"),
      );
      expectError(
        yield* send(h, { command: "press", ref: refs.save }),
        "CU-CON-008",
        "not-dispatched",
      );
      // Never resolved: the turn ending clears it.
      yield* h.service.endTurn(threadId, h.thread.turnId);
      h.thread.turnId = TurnId.make("turn-2");
      expectDispatched(yield* send(h, { command: "press", ref: refs.save }));
    }).pipe(Effect.scoped),
  );

  it.effect("an interrupt without a turn id ends the turn the projection still shows", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      yield* h.service.endTurn(threadId);
      expectError(
        yield* send(h, { command: "press", ref: refs.save }),
        "CU-CON-006",
        "not-dispatched",
      );
      expect(inputCalls(h)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("moving or scrolling over a destructive-looking control is not refused", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const { shot } = yield* shootNotes(h);
      h.hit = { role: "button", label: "Delete" };
      const moved = yield* send(h, { command: "move", shot, x: 1, y: 1 });
      expectDispatched(moved);
      if (!moved.ok || moved.result.kind !== "input") throw new Error("move failed");
      expectDispatched(
        yield* send(h, {
          command: "scroll-at",
          shot: moved.result.screenshot!.shot,
          x: 1,
          y: 1,
          dx: 0,
          dy: 1,
        }),
      );
      expect(h.events).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("judges a long label by the clipped text the agent and approval saw", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.thread.runtimeMode = "full-access";
      const full = `Open ${"x".repeat(250)} delete`;
      h.elements = [{ ...save, handle: "e-long", label: `${full.slice(0, 199)}…` }];
      h.native.set("e-long", { role: "button", label: full });
      const refs = yield* observeNotes(h);
      expectDispatched(yield* send(h, { command: "press", ref: refs.save }));
    }).pipe(Effect.scoped),
  );

  it.effect("reports a driver failure while refreshing windows, not an internal error", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const refs = yield* observeNotes(h);
      h.listFailure = new ComputerDriverError({
        kind: "permission-accessibility",
        message: "Accessibility is off.",
        dispatched: "no",
      });
      expectError(yield* send(h, { command: "observe", window: refs.window }), "CU-EXT-002");
      expectError(yield* send(h, { command: "screenshot", window: refs.window }), "CU-EXT-002");
    }).pipe(Effect.scoped),
  );

  it.effect("discards a capture when a protected window appeared during it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const listed = yield* send(h, { command: "list-windows" });
      if (!listed.ok || listed.result.kind !== "windows") throw new Error("list failed");
      const window = listed.result.windows.find((entry) => entry.app === "Notes")!.id;
      let written: string | undefined;
      h.duringCapture = (outputPath) => {
        NodeFS.writeFileSync(outputPath, "pixels");
        written = outputPath;
        h.windows = [
          notes,
          { ...onePassword, bounds: { x: 700, y: 500, width: 400, height: 400 } },
          viewCode,
        ];
      };
      expectError(yield* send(h, { command: "screenshot", window }), "CU-CON-005");
      expect(written).toBeDefined();
      expect(NodeFS.existsSync(written!)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

/** A stub worker script whose requests can be held over HTTP by the test. */
const stubWorker = (handlers: Record<string, () => void>, source: (port: number) => string) =>
  Effect.gen(function* () {
    const server = NodeHttp.createServer((req, res) => {
      const handler = handlers[req.url ?? ""];
      if (handler) {
        held.set(req.url ?? "", () => res.end("ok"));
        handler();
      } else res.end("ok");
    });
    const held = new Map<string, () => void>();
    yield* Effect.promise(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-review-worker-"));
    const script = NodePath.join(dir, "worker.cjs");
    NodeFS.writeFileSync(script, source(address.port));
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise<void>((r) => {
            for (const release of held.values()) release();
            server.close(() => r());
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }),
      ),
    );
    const driver = yield* makeXa11yComputerDriver({
      platform: "darwin",
      launch: () => ({ command: process.execPath, args: [script], env: { ...process.env } }),
    });
    return { driver, release: (path: string) => held.get(path)?.() };
  });

const workerPrelude = (port: number) => `const http=require('node:http');
const get = path => new Promise(resolve => http.get('http://127.0.0.1:${port}'+path, res => {res.resume(); res.on('end',resolve);}));
const notes = {window:{handle:'w-notes',app:'Notes',pid:10,title:'Shopping list',focused:true}};`;

const settledNow = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.gen(function* () {
    for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
    return fiber.pollUnsafe() !== undefined;
  });

describe("Computer use dispatch lock", () => {
  it.effect("an interrupted input keeps the dispatch lock until the worker replies", () =>
    Effect.gen(function* () {
      const typing = Promise.withResolvers<void>();
      const stub = yield* stubWorker(
        { "/typing": () => typing.resolve() },
        (port) => `${workerPrelude(port)}
process.on('message', async message => {
 const {id,request,decision}=message;
 if ('decision' in message) {
  if (decision) return process.send({id,ok:false,error:{kind:'policy',code:decision.code,message:decision.message,dispatched:'no'}});
  await get('/typing');
  return process.send({id,ok:true,result:null});
 }
 if (request.op==='key') process.send({id,authorize:notes,phase:'dispatch'});
}); process.once('disconnect',()=>process.exit(0));`,
      );
      const h = yield* makeHarness("control", (driver) => ({ ...driver, key: stub.driver.key }));
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      const action = yield* Effect.forkChild(
        send(h, { command: "key", window: refs.window, keys: "enter" }),
      );
      yield* Effect.promise(() => typing.promise);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(action));
      const tracking = yield* Effect.forkChild(
        h.service.trackProviderApproval(providerRequest(h, "command_execution_approval", "late")),
      );
      const whileTyping = {
        interrupted: yield* settledNow(interrupting),
        tracked: yield* settledNow(tracking),
      };
      stub.release("/typing");
      yield* Fiber.join(interrupting);
      yield* Fiber.join(tracking);
      expect(whileTyping).toEqual({ interrupted: false, tracked: false });
    }).pipe(Effect.scoped),
  );

  it.effect("input waiting for the driver does not hold the dispatch lock", () =>
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      let delivered = false;
      const stub = yield* stubWorker(
        { "/read": () => reading.resolve() },
        (port) => `${workerPrelude(port)}
process.on('message', async message => {
 const {id,request,decision}=message;
 if ('decision' in message) {
  if (decision) return process.send({id,ok:false,error:{kind:'policy',code:decision.code,message:decision.message,dispatched:'no'}});
  await get('/sent');
  return process.send({id,ok:true,result:null});
 }
 if (request.op==='listWindows') {await get('/read'); process.send({id,ok:true,result:[]});}
 else if (request.op==='key') process.send({id,authorize:notes,phase:'dispatch'});
}); process.once('disconnect',()=>process.exit(0));`,
      );
      const enteredKey = yield* Deferred.make<void>();
      const h = yield* makeHarness("control", (driver) => ({
        ...driver,
        key: (window, keys) =>
          Deferred.succeed(enteredKey, undefined).pipe(
            Effect.andThen(stub.driver.key(window, keys)),
            Effect.tap(() => Effect.sync(() => (delivered = true))),
          ),
      }));
      h.thread.runtimeMode = "full-access";
      const refs = yield* observeNotes(h);
      // Another request occupies the worker; the key queues behind it.
      const listing = yield* Effect.forkChild(stub.driver.listWindows());
      yield* Effect.promise(() => reading.promise);
      const action = yield* Effect.forkChild(
        send(h, { command: "key", window: refs.window, keys: "enter" }),
      );
      yield* Deferred.await(enteredKey);
      const tracking = yield* Effect.forkChild(
        h.service.trackProviderApproval(providerRequest(h, "command_execution_approval", "card")),
      );
      const trackedWhileQueued = yield* settledNow(tracking);
      stub.release("/read");
      yield* Fiber.join(listing);
      yield* Fiber.join(tracking);
      expect(trackedWhileQueued).toBe(true);
      expectError(yield* Fiber.join(action), "CU-CON-008", "not-dispatched");
      expect(delivered).toBe(false);
    }).pipe(Effect.scoped),
  );
});
