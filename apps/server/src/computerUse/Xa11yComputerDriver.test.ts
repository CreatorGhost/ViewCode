// @effect-diagnostics nodeBuiltinImport:off - writes a stub worker script for the real child-process client.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { afterAll } from "vite-plus/test";

import {
  ComputerDriver,
  ComputerDriverDispatchCheck,
  ComputerDriverError,
} from "./ComputerDriver.ts";
import { layer, makeXa11yComputerDriver } from "./Xa11yComputerDriver.ts";

// Answers by op instead of driving xa11y: each op exercises one way a real
// worker can misbehave.
const STUB_WORKER = `
const fs = require("node:fs");
const log = process.argv[2];
const nonce = process.env.VIEWCODE_COMPUTER_DRIVER_NONCE;
const target = { window: { handle: "w1", app: "Notes", pid: 1, title: "t", focused: true } };
let authorizing;
process.on("message", (message) => {
  const { id, nonce: sent, request } = message;
  if ("decision" in message) {
    if (message.decision) {
      return process.send({ id, ok: false, error: { kind: "policy", message: "no", dispatched: "no" } });
    }
    switch (authorizing) {
      case "press":
        return process.exit(3); // dies during the allowed input
      case "key":
      case "drag":
        return; // never answers after the allowed input
    }
    return;
  }
  if (log) fs.appendFileSync(log, request.op + "\\n");
  switch (request.op) {
    case "elementAt": // probe: which process answered, and did it get the nonce
      return process.send({ id, ok: true, result: {
        role: String(process.pid),
        label: typeof nonce === "string" && nonce.length === 64 && sent === nonce ? "nonce-ok" : "nonce-bad",
      } });
    case "releaseMouse":
      return process.send({ id, ok: true, result: null });
    case "drag":
    case "press":
    case "key":
      authorizing = request.op;
      return process.send({ id, authorize: target, phase: "dispatch" });
    case "move":
      return process.exit(3); // dies before asking to dispatch
    case "scrollAt":
      return; // never asks to dispatch
    case "status":
      return process.send({ id, ok: true, result: { available: true, accessibility: "granted" } });
    case "listWindows":
      return process.send({ id, ok: true, result: [{ handle: 7 }] });
    case "observe":
      return process.send({ id: id + 1, ok: true, result: { elements: [], truncated: false } });
    case "setValue":
      return process.send({ id, ok: true, result: { tookFocus: false } });
    case "typeText": // a handle from an earlier worker
      return process.send({ id, ok: false, error: { kind: "stale", message: "restarted", dispatched: "no", reason: "restarted" } });
    case "scroll":
      return process.send({ id, ok: false, error: { kind: "stale", message: "changed", dispatched: "no" } });
  }
});
process.once("disconnect", () => process.exit(0));
`;

const stubDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-driver-"));
afterAll(() => NodeFS.rmSync(stubDirectory, { recursive: true, force: true }));
const stubScript = () => {
  const script = NodePath.join(stubDirectory, "stub-worker.cjs");
  NodeFS.writeFileSync(script, STUB_WORKER);
  return script;
};

const makeDriver = (
  options: {
    readonly command?: string;
    readonly platform?: NodeJS.Platform;
    readonly log?: string;
    readonly recycleAfter?: number;
  } = {},
) => {
  const script = stubScript();
  return makeXa11yComputerDriver({
    platform: options.platform ?? "darwin",
    launch: () => ({
      command: options.command ?? process.execPath,
      args: options.log ? [script, options.log] : [script],
      env: { ...process.env },
    }),
    timeouts: { key: 300, drag: 300, scrollAt: 300 },
    ...(options.recycleAfter ? { recycleAfter: options.recycleAfter } : {}),
  });
};

let logCount = 0;
const opLog = () => {
  const path = NodePath.join(stubDirectory, `ops-${logCount++}.log`);
  return { path, read: () => NodeFS.readFileSync(path, "utf8").trim().split("\n") };
};

const probe = { x: 1, y: 1 };

const identity = { role: "button", label: "OK" };

/** The server's dispatch check, allowing everything. */
const allowAll = Effect.provideService(ComputerDriverDispatchCheck, () =>
  Effect.succeed({ allowed: true as const, release: Effect.void }),
);

const failureOf = <A>(effect: Effect.Effect<A, ComputerDriverError>) =>
  Effect.flip(effect).pipe(Effect.map(({ kind, dispatched }) => ({ kind, dispatched })));

describe("Xa11yComputerDriver", () => {
  it.effect("decodes valid replies and passes worker refusals through", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual(yield* driver.status(), {
          available: true,
          accessibility: "granted",
        });
        assert.deepStrictEqual(yield* driver.setValue("e1", identity, "secret"), {
          tookFocus: false,
        });
        assert.deepStrictEqual(yield* failureOf(driver.scroll("e1", identity, 0, 3)), {
          kind: "stale",
          dispatched: "no",
        });
        assert.strictEqual(
          (yield* Effect.flip(driver.scroll("e1", identity, 0, 3))).reason,
          undefined,
        );
        assert.strictEqual(
          (yield* Effect.flip(driver.typeText("e1", identity, "x"))).reason,
          "restarted",
        );
      }),
    ),
  );

  it.effect("rejects a reply of the wrong shape or for another request as malformed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual(yield* failureOf(driver.listWindows()), {
          kind: "malformed",
          dispatched: "no",
        });
        assert.deepStrictEqual(yield* failureOf(driver.observe("w1", { maxElements: 10 })), {
          kind: "malformed",
          dispatched: "no",
        });
      }),
    ),
  );

  it.effect("reports a worker that dies during input as dispatched-unknown, then restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual(yield* failureOf(driver.press("e1", identity)), {
          kind: "failed",
          dispatched: "unknown",
        });
        assert.deepStrictEqual(yield* driver.status(), {
          available: true,
          accessibility: "granted",
        });
      }),
    ).pipe(allowAll),
  );

  it.effect("times out a silent worker as dispatched-unknown and replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual(yield* failureOf(driver.key("w1", "enter")), {
          kind: "timeout",
          dispatched: "unknown",
        });
        yield* driver.setValue("e1", identity, "x");
      }),
    ).pipe(allowAll),
  );

  it.effect("a worker lost before any allowed dispatch sent nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = opLog();
        const driver = yield* makeDriver({ log: log.path });
        const rect = { x: 0, y: 0, width: 10, height: 10 };
        assert.deepStrictEqual(yield* failureOf(driver.move("w1", rect, probe)), {
          kind: "failed",
          dispatched: "no",
        });
        assert.deepStrictEqual(yield* failureOf(driver.scrollAt("w1", rect, probe, 0, 1)), {
          kind: "timeout",
          dispatched: "no",
        });
        // Refused at the dispatch check: no input, so no mouse release either.
        assert.deepStrictEqual(yield* failureOf(driver.drag("w1", rect, probe, probe)), {
          kind: "policy",
          dispatched: "no",
        });
        yield* driver.setValue("e1", identity, "x");
        assert.deepStrictEqual(log.read(), ["move", "scrollAt", "drag", "setValue"]);
      }),
    ),
  );

  it.effect("never fails status, and refuses input before dispatch when no worker starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver({ command: "/nonexistent/viewcode-node" });
        const status = yield* driver.status();
        assert.strictEqual(status.available, false);
        assert.deepStrictEqual(yield* failureOf(driver.press("e1", identity)), {
          kind: "unavailable",
          dispatched: "no",
        });

        const unsupported = yield* makeDriver({ platform: "freebsd" });
        assert.strictEqual((yield* unsupported.status()).available, false);
      }),
    ),
  );

  // The real worker entry, launched the way the server launches it. Without
  // a display or permissions it reports why it is unavailable; the point is
  // that it started and answered rather than failing to launch.
  it.effect("launches the real driver worker from source", () =>
    Effect.gen(function* () {
      const driver = yield* ComputerDriver;
      const status = yield* driver.status();
      assert.notStrictEqual(status.reason, "The computer-use driver could not start.");
      assert.notStrictEqual(
        status.reason,
        "The computer-use driver answered with an invalid reply.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("hands every worker a fresh nonce it must echo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual((yield* driver.elementAt("w1", probe))?.label, "nonce-ok");
      }),
    ),
  );

  it.effect("recycles the worker after a number of requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver({ recycleAfter: 2 });
        const pids = [];
        for (let index = 0; index < 3; index += 1) {
          pids.push((yield* driver.elementAt("w1", probe))?.role);
        }
        assert.strictEqual(pids[0], pids[1]);
        assert.notStrictEqual(pids[1], pids[2]);
      }),
    ),
  );

  it.effect("releases the mouse first after a worker died during a drag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = opLog();
        const driver = yield* makeDriver({ log: log.path });
        const rect = { x: 0, y: 0, width: 10, height: 10 };
        assert.deepStrictEqual(yield* failureOf(driver.drag("w1", rect, probe, probe)), {
          kind: "timeout",
          dispatched: "unknown",
        });
        yield* driver.setValue("e1", identity, "x");
        assert.deepStrictEqual(log.read(), ["drag", "releaseMouse", "setValue"]);
      }),
    ).pipe(allowAll),
  );

  it.effect("never sends a queued request whose caller was interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const log = opLog();
        const driver = yield* makeDriver({ log: log.path });
        const hanging = yield* Effect.forkChild(Effect.flip(driver.key("w1", "enter")));
        const queued = yield* Effect.forkChild(driver.setValue("e1", identity, "x"));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(queued);
        yield* Fiber.join(hanging);
        yield* driver.status();
        assert.deepStrictEqual(log.read(), ["key", "status"]);
      }),
    ).pipe(allowAll),
  );

  it.effect("logs worker lifecycle and timeouts without request contents", () => {
    const entries: Array<{ readonly text: unknown; readonly fields: Record<string, unknown> }> = [];
    const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
      const [text, fields] = Array.isArray(message) ? message : [message];
      if (logLevel === "Info") entries.push({ text, fields: fields ?? {} });
    });
    const stops = () =>
      entries.filter((entry) => entry.text === "computer-use driver stopped").map((e) => e.fields);
    return Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        yield* driver.setValue("e1", { role: "text field", label: "Account" }, "secret-value");
        const [started] = entries;
        assert.strictEqual(started?.text, "computer-use driver started");
        assert.strictEqual(typeof started?.fields.pid, "number");
        assert.match(String(started?.fields.epoch), /^[0-9a-f]{8}$/);

        yield* Effect.flip(driver.key("w1", "cmd+q"));
        assert.deepStrictEqual(
          entries.find((entry) => entry.text === "computer-use driver call timed out")?.fields,
          { op: "key", timeoutMs: 300 },
        );
        yield* Effect.flip(driver.press("e1", identity));
        yield* Effect.flip(driver.observe("w1", { maxElements: 10 }));
        assert.deepStrictEqual(
          stops().map(({ reason, code }) => [reason, code]),
          [
            ["timeout", undefined],
            ["crash", 3],
            ["malformed", undefined],
          ],
        );
        assert.deepStrictEqual(
          stops().map(({ epoch }) => typeof epoch),
          ["string", "string", "string"],
        );

        const recycling = yield* makeDriver({ recycleAfter: 1 });
        yield* recycling.status();
        assert.strictEqual(stops().at(-1)?.reason, "recycle");

        const text = entries
          .flatMap((entry) => [String(entry.text), ...Object.values(entry.fields).map(String)])
          .join("\n");
        for (const secret of ["secret-value", "Account", "cmd+q", "OK"]) {
          assert.notInclude(text, secret);
        }
      }),
    ).pipe(allowAll, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("refuses on Windows without starting a worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver({ platform: "win32", command: "/nonexistent/never" });
        assert.deepStrictEqual(yield* driver.status(), {
          available: false,
          accessibility: "unknown",
          reason: "Computer use is not supported on Windows yet.",
        });
        assert.deepStrictEqual(yield* failureOf(driver.press("e1", identity)), {
          kind: "unavailable",
          dispatched: "no",
        });
      }),
    ),
  );

  // The hidden entry, started by hand the way an agent's shell could.
  it.each([
    ["without a nonce", {}, undefined],
    ["with the wrong nonce", { VIEWCODE_COMPUTER_DRIVER_NONCE: "a".repeat(64) }, "b".repeat(64)],
  ] as const)("the driver worker refuses to serve %s", async (_name, extraEnv, sentNonce) => {
    const entry = NodePath.join(import.meta.dirname, "..", "computer-use-driver.ts");
    const child = NodeChildProcess.spawn(process.execPath, [entry], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const replies: unknown[] = [];
    child.on("message", (message) => replies.push(message));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.send({ id: 1, nonce: sentNonce, request: { op: "status" } }, () => undefined);
    assert.strictEqual(await exited, 2);
    assert.deepStrictEqual(replies, []);
  });
});
