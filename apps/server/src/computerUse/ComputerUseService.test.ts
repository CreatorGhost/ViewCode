import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
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
  ComputerDriverError,
  type ComputerDriverShape,
  type DriverElement,
  type DriverElementIdentity,
  type DriverWindow,
} from "./ComputerDriver.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

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
};
const onePassword: DriverWindow = {
  handle: "w-1p",
  app: "1Password",
  pid: 11,
  title: "Vault",
  focused: false,
  appIdentifier: "/Applications/1Password.app/Contents/MacOS/1Password",
};
const viewCode: DriverWindow = {
  handle: "w-vc",
  app: "ViewCode",
  pid: 12,
  title: "Thread",
  focused: false,
  appIdentifier: "/Applications/ViewCode.app/Contents/MacOS/ViewCode",
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
}

/** A 1568×980 image of a 784×490-point window at (100, 50): half a point per pixel. */
const SHOT_BOUNDS: ComputerUseRect = { x: 100, y: 50, width: 784, height: 490 };

const makeHarness = (initialMode: ComputerUseMode = "control") =>
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
    };
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

    const action =
      (name: string) =>
      (handle: string): Effect.Effect<void, ComputerDriverError> =>
        Effect.suspend(() => {
          calls.push(`${name}:${handle}`);
          const failure = state.failNext;
          state.failNext = undefined;
          return failure ? Effect.fail(failure) : Effect.void;
        });
    const driver: ComputerDriverShape = {
      status: () => Effect.succeed({ available: true, accessibility: "granted" }),
      listWindows: () =>
        Effect.sync(() => {
          calls.push("listWindows");
          return [notes, onePassword, viewCode];
        }),
      observe: (handle) =>
        Effect.suspend(() => {
          calls.push(`observe:${handle}`);
          const failure = state.failNext;
          state.failNext = undefined;
          return failure
            ? Effect.fail(failure)
            : Effect.succeed({ elements: [save, remove, field], truncated: false });
        }),
      screenshot: (handle) =>
        Effect.suspend(() => {
          calls.push(`screenshot:${handle}`);
          return state.screenshotFailure
            ? Effect.fail(state.screenshotFailure)
            : Effect.succeed({ width: 1568, height: 980, bounds: SHOT_BOUNDS });
        }),
      elementAt: (handle) =>
        Effect.sync(() => {
          calls.push(`elementAt:${handle}`);
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
      Layer.provide(Layer.succeed(ComputerDriver, driver)),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.some(shell())),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-use-test-" })),
      Layer.provide(Layer.succeed(ComputerUseService.ComputerUseSettleDelay, Duration.zero)),
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
      expect(harness.calls).toEqual(["listWindows", `observe:${notes.handle}`]);
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
