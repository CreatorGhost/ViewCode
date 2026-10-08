// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - runs the real CLI as a child process against a real HTTP listener.
/**
 * End to end: the actual `viewcode-computer` CLI (a child process, started the
 * way the shim starts it) talks over a real unix socket or TCP port to the real
 * route, the real `McpSessionRegistry` credential check and the real
 * `ComputerUseService`. Only the desktop driver is fake. The per-piece
 * behaviours are covered in the neighbouring unit tests; this file proves the
 * pieces agree with each other.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ComputerUseMode,
  type ComputerUseRect,
  type OrchestrationThreadShell,
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
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerDriver,
  type ComputerDriverShape,
  type DriverElement,
  type DriverElementIdentity,
  type DriverInputResult,
  type DriverWindow,
} from "./ComputerDriver.ts";
import { computerUseRouteLayer } from "./ComputerUseRoute.ts";
import { ServerProcessAncestry } from "./computerUseAncestry.ts";
import * as ComputerUseService from "./ComputerUseService.ts";

const CLI_ENTRY = NodePath.join(import.meta.dirname, "..", "viewcode-computer.ts");
const TEST_TIMEOUT = 60_000;

const NOW = "2026-10-06T00:00:00.000Z";
const threadId = ThreadId.make("thread-end-to-end");
const providerInstanceId = ProviderInstanceId.make("codex");

const notes: DriverWindow = {
  handle: "w-notes",
  app: "Notes",
  pid: 10,
  title: "Shopping list",
  focused: true,
  appIdentifier: "/System/Applications/Notes.app/Contents/MacOS/Notes",
};
const save: DriverElement = {
  handle: "e-save",
  role: "button",
  label: "Save",
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

/** A 1568x980 image of a 784x490-point window at (100, 50): half a point per pixel. */
const SHOT_BOUNDS: ComputerUseRect = { x: 100, y: 50, width: 784, height: 490 };

/**
 * The service's fake driver plus the thread it runs in (the same shape as the
 * harness in `ComputerUseService.test.ts`, trimmed to what this file needs).
 */
const makeStack = (listen: "unix" | "tcp") =>
  Effect.gen(function* () {
    /** Driver calls in order, as `method:handle`. */
    const calls: Array<string> = [];
    const pressed: Array<{ handle: string; expect: DriverElementIdentity }> = [];
    const typed: Array<{ handle: string; text: string }> = [];
    const events: Array<ProviderRuntimeEvent> = [];
    const openedApprovals = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const thread = { runtimeMode: "approval-required" as RuntimeMode, turnId: TurnId.make("t-1") };

    const record =
      (name: string) =>
      (handle: string): Effect.Effect<DriverInputResult> =>
        Effect.sync(() => (calls.push(`${name}:${handle}`), { tookFocus: true }));
    const driver: ComputerDriverShape = {
      status: () => Effect.succeed({ available: true, accessibility: "granted" }),
      listWindows: () => Effect.sync(() => (calls.push("listWindows"), [notes])),
      observe: (handle) =>
        Effect.sync(() => {
          calls.push(`observe:${handle}`);
          return { elements: [save, field], truncated: false };
        }),
      screenshot: (handle) =>
        Effect.sync(() => {
          calls.push(`screenshot:${handle}`);
          return { width: 1568, height: 980, bounds: SHOT_BOUNDS };
        }),
      elementAt: (handle) => Effect.sync(() => (calls.push(`elementAt:${handle}`), null)),
      press: (handle, expectIdentity) =>
        Effect.sync(() => {
          calls.push(`press:${handle}`);
          pressed.push({ handle, expect: expectIdentity });
          return { tookFocus: false };
        }),
      typeFocused: (handle, text) =>
        Effect.sync(() => {
          calls.push(`typeFocused:${handle}`);
          typed.push({ handle, text });
          return { tookFocus: true };
        }),
      click: (handle, _bounds, point, options) =>
        Effect.sync(() => {
          calls.push(`click(${options.button}x${options.count}):${point.x},${point.y}:${handle}`);
          return { tookFocus: true };
        }),
      drag: (handle) => record("drag")(handle),
      move: (handle) => record("move")(handle),
      scrollAt: (handle) => record("scrollAt")(handle),
      setValue: (handle) => record("setValue")(handle),
      typeText: (handle) => record("typeText")(handle),
      key: (handle) => record("key")(handle),
      scroll: (handle) => record("scroll")(handle),
      focus: (handle) => record("focus")(handle),
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
        status: "running",
        providerName: "codex",
        providerInstanceId,
        runtimeMode: thread.runtimeMode,
        activeTurnId: thread.turnId,
        lastError: null,
        updatedAt: NOW,
      },
      latestUserMessageAt: NOW,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    const mode: ComputerUseMode = "control";
    const serviceLayer = ComputerUseService.layer.pipe(
      Layer.provideMerge(ServerSettings.layerTest({ computerUse: mode })),
      Layer.provide(Layer.succeed(ComputerDriver, driver)),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.some(shell())),
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-e2e-" })),
      Layer.provide(Layer.succeed(ComputerUseService.ComputerUseSettleDelay, Duration.zero)),
      Layer.provide(
        Layer.succeed(ComputerUseService.ComputerUsePendingApprovals, {
          anyPending: Effect.succeed(false),
        }),
      ),
      Layer.provide(Layer.succeed(ServerProcessAncestry, new Set<number>())),
      Layer.provide(NodeServices.layer),
    );
    const service = Context.get(
      yield* Layer.build(serviceLayer),
      ComputerUseService.ComputerUseService,
    );
    yield* service.attachRuntimeEventPublisher((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "request.opened") yield* Queue.offer(openedApprovals, event);
      }),
    );

    // The real HTTP listener, then the real registry on top of its address.
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-e2e-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const listener =
      listen === "unix"
        ? NodeHttpServer.layer(() => NodeHttp.createServer(), {
            path: NodePath.join(directory, "server.sock"),
          })
        : NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" });
    const httpServer = Context.get(yield* Layer.build(listener), HttpServer.HttpServer);

    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provide(NodeServices.layer),
    );
    yield* HttpRouter.serve(
      computerUseRouteLayer.pipe(
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        Layer.provide(Layer.succeed(ComputerUseService.ComputerUseService, service)),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer, httpServer)), Layer.build);

    const issue = (capabilities: ReadonlyArray<"computer" | "agents">) =>
      registry.issue({ threadId, providerInstanceId, capabilities: new Set(capabilities) });
    const credential = (yield* issue(["computer"])).config;
    expect(credential.computerUseEndpoint).toBeDefined();

    return {
      service,
      calls,
      pressed,
      typed,
      events,
      openedApprovals,
      thread,
      issue,
      endpoint: credential.computerUseEndpoint!,
      authorization: credential.authorizationHeader,
      /** Driver calls that acted on the desktop (not listing, reading or capturing). */
      inputCalls: () =>
        calls.filter((call) => !/^(listWindows|observe|screenshot|elementAt)/.test(call)),
    };
  });

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The parsed single JSON line the CLI printed. */
  readonly json: {
    readonly ok: boolean;
    readonly result?: any;
    readonly error?: { readonly code: string; readonly effect?: string };
  };
}

/** Starts `viewcode-computer` as the shim would (the runtime's own binary on the TS entry). */
const startCli = (
  stack: { readonly endpoint: string; readonly authorization: string },
  argv: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly authorization?: string } = {},
) =>
  Effect.promise<CliRun>(
    () =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [CLI_ENTRY, ...argv], {
          env: {
            PATH: process.env.PATH ?? "",
            VIEWCODE_COMPUTER_ENDPOINT: stack.endpoint,
            VIEWCODE_COMPUTER_AUTH: options.authorization ?? stack.authorization,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          let json: CliRun["json"];
          try {
            json = JSON.parse(stdout);
          } catch {
            return reject(new Error(`CLI printed no JSON (exit ${code}): ${stdout}${stderr}`));
          }
          resolve({ code, stdout, stderr, json });
        });
        child.stdin.end(options.stdin ?? "");
      }),
  );

type Stack = Effect.Success<ReturnType<typeof makeStack>>;

const cli = (stack: Stack, argv: ReadonlyArray<string>, options?: { readonly stdin?: string }) =>
  startCli(stack, argv, options);

const windowId = (stack: Stack) =>
  cli(stack, ["list-windows"]).pipe(
    Effect.map((run) => {
      expect(run.code).toBe(0);
      return run.json.result.windows.find((entry: { app: string }) => entry.app === "Notes")
        .id as number;
    }),
  );

describe("viewcode-computer end to end", () => {
  it.live(
    "lists, observes and presses a ref in full access over a unix socket",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("unix");
        expect(stack.endpoint).toMatch(/^unix:.*server\.sock$/);
        stack.thread.runtimeMode = "full-access";

        const listed = yield* cli(stack, ["list-windows"]);
        expect(listed.code).toBe(0);
        expect(listed.json.result.kind).toBe("windows");
        expect(listed.json.result.windows).toMatchObject([
          { app: "Notes", title: "Shopping list" },
        ]);
        const window = yield* windowId(stack);

        const observed = yield* cli(stack, ["observe", "--window", String(window)]);
        expect(observed.code).toBe(0);
        expect(observed.json.result.elements).toMatchObject([
          { role: "button", label: "Save" },
          { role: "text field", label: "Title" },
        ]);
        const saveRef = observed.json.result.elements[0].ref as number;

        const pressedRun = yield* cli(stack, ["press", "--ref", String(saveRef)]);
        expect(pressedRun.code).toBe(0);
        expect(pressedRun.json).toMatchObject({
          ok: true,
          result: { kind: "input", effect: "dispatched" },
        });
        // The driver got the handle it minted and the identity the agent observed.
        expect(stack.pressed).toEqual([
          { handle: "e-save", expect: { role: "button", label: "Save" } },
        ]);
        expect(stack.events).toEqual([]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );

  it.live(
    "maps a screenshot point to the screen and makes the returned shot the newest",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("unix");
        stack.thread.runtimeMode = "full-access";
        const window = yield* windowId(stack);

        const shotRun = yield* cli(stack, ["screenshot", "--window", String(window)]);
        expect(shotRun.code).toBe(0);
        const oldShot = shotRun.json.result.shot as number;

        const clicked = yield* cli(stack, [
          "click",
          "--shot",
          String(oldShot),
          "--x",
          "100",
          "--y",
          "200",
        ]);
        expect(clicked.code).toBe(0);
        // Pixel (100, 200) is the centre of its cell: 100.5 * 0.5 + 100 and 200.5 * 0.5 + 50.
        expect(stack.inputCalls()).toEqual([`click(leftx1):150.25,150.25:${notes.handle}`]);
        const fresh = clicked.json.result.screenshot;
        expect(fresh.shot).toBeGreaterThan(oldShot);
        expect(fresh).toMatchObject({ width: 1568, height: 980 });

        // The old shot is no longer the window's newest: refused, never dispatched.
        const stale = yield* cli(stack, [
          "click",
          "--shot",
          String(oldShot),
          "--x",
          "1",
          "--y",
          "1",
        ]);
        expect(stale.code).toBe(1);
        expect(stale.json.error).toMatchObject({ code: "CU-CON-007", effect: "not-dispatched" });
        expect(stack.inputCalls()).toHaveLength(1);

        const next = yield* cli(stack, [
          "click",
          "--shot",
          String(fresh.shot),
          "--x",
          "1",
          "--y",
          "1",
        ]);
        expect(next.code).toBe(0);
        expect(stack.inputCalls()).toHaveLength(2);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );

  it.live(
    "holds a press behind an approval and does not dispatch when the user declines",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("unix");
        const window = yield* windowId(stack);
        const observed = yield* cli(stack, ["observe", "--window", String(window)]);
        const saveRef = observed.json.result.elements[0].ref as number;

        const pending = yield* startCli(stack, ["press", "--ref", String(saveRef)]).pipe(
          Effect.forkChild,
        );
        const opened = yield* Queue.take(stack.openedApprovals);
        if (opened.type !== "request.opened") throw new Error("expected request.opened");
        // The CLI is parked on the HTTP request while the approval is open.
        expect(stack.inputCalls()).toEqual([]);
        expect(opened.payload.detail).toContain('button "Save"');

        expect(
          yield* stack.service.respondToApproval({
            threadId,
            requestId: opened.requestId!,
            decision: "decline",
          }),
        ).toBe("handled");
        const declined = yield* Fiber.join(pending);
        expect(declined.code).toBe(1);
        expect(declined.json).toMatchObject({
          ok: false,
          error: { code: "CU-CON-004", effect: "not-dispatched" },
        });
        expect(stack.inputCalls()).toEqual([]);
        expect(stack.pressed).toEqual([]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );

  it.live(
    "rejects a wrong credential, and one that was not granted computer use, as CU-CON-001",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("unix");
        stack.thread.runtimeMode = "full-access";

        const forged = yield* cli({ ...stack, authorization: "Bearer not-a-real-credential" }, [
          "list-windows",
        ]);
        expect(forged.code).toBe(1);
        expect(forged.json.error?.code).toBe("CU-CON-001");

        const withoutComputer = (yield* stack.issue(["agents"])).config.authorizationHeader;
        const refused = yield* cli({ ...stack, authorization: withoutComputer }, ["list-windows"]);
        expect(refused.code).toBe(1);
        expect(refused.json.error?.code).toBe("CU-CON-001");
        expect(refused.json.error).not.toEqual(forged.json.error);

        expect(stack.calls).toEqual([]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );

  it.live(
    "delivers --text - from stdin to the driver unchanged, unicode included",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("unix");
        stack.thread.runtimeMode = "full-access";
        const window = yield* windowId(stack);

        const text = 'héllo wörld 🌍 日本語 "quoted" \\ back\nsecond line';
        const run = yield* cli(stack, ["type", "--window", String(window), "--text", "-"], {
          stdin: `${text}\n`,
        });
        expect(run.code).toBe(0);
        expect(run.json).toMatchObject({ ok: true, result: { effect: "dispatched" } });
        // One trailing newline is dropped; everything else arrives byte for byte.
        expect(stack.typed).toEqual([{ handle: notes.handle, text }]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );

  it.live(
    "works over a TCP endpoint too",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("tcp");
        expect(stack.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/computer-use$/);
        stack.thread.runtimeMode = "full-access";
        const window = yield* windowId(stack);

        const observed = yield* cli(stack, ["observe", "--window", String(window)]);
        expect(observed.code).toBe(0);
        const saveRef = observed.json.result.elements[0].ref as number;
        const pressedRun = yield* cli(stack, ["press", "--ref", String(saveRef)]);
        expect(pressedRun.code).toBe(0);
        expect(stack.pressed.map((entry) => entry.handle)).toEqual(["e-save"]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );
});
