// @effect-diagnostics nodeBuiltinImport:off - writes a stub worker script for the real child-process client.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterAll } from "vite-plus/test";

import { ComputerDriver, ComputerDriverError } from "./ComputerDriver.ts";
import { layer, makeXa11yComputerDriver } from "./Xa11yComputerDriver.ts";

// Answers by op instead of driving xa11y: each op exercises one way a real
// worker can misbehave.
const STUB_WORKER = `
const fs = require("node:fs");
const log = process.argv[2];
const nonce = process.env.VIEWCODE_COMPUTER_DRIVER_NONCE;
process.on("message", ({ id, nonce: sent, request }) => {
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
      return; // never answers
    case "status":
      return process.send({ id, ok: true, result: { available: true, accessibility: "granted" } });
    case "listWindows":
      return process.send({ id, ok: true, result: [{ handle: 7 }] });
    case "observe":
      return process.send({ id: id + 1, ok: true, result: { elements: [], truncated: false } });
    case "press":
      return process.exit(3);
    case "key":
      return; // never answers
    case "setValue":
      return process.send({ id, ok: true, result: null });
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
    timeouts: { key: 300, drag: 300 },
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
        yield* driver.setValue("e1", identity, "secret");
        assert.deepStrictEqual(yield* failureOf(driver.scroll("e1", identity, 0, 3)), {
          kind: "stale",
          dispatched: "no",
        });
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
    ),
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
    ),
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
    ),
  );

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
