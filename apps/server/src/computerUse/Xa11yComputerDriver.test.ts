// @effect-diagnostics nodeBuiltinImport:off - writes a stub worker script for the real child-process client.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll } from "vite-plus/test";

import { ComputerDriver, ComputerDriverError } from "./ComputerDriver.ts";
import { layer, makeXa11yComputerDriver } from "./Xa11yComputerDriver.ts";

// Answers by op instead of driving xa11y: each op exercises one way a real
// worker can misbehave.
const STUB_WORKER = `
process.on("message", ({ id, request }) => {
  switch (request.op) {
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
  const script = NodePath.join(stubDirectory, "stub-worker.mjs");
  NodeFS.writeFileSync(script, STUB_WORKER);
  return script;
};

const makeDriver = (
  options: { readonly command?: string; readonly platform?: NodeJS.Platform } = {},
) => {
  const script = stubScript();
  return makeXa11yComputerDriver({
    platform: options.platform ?? "darwin",
    launch: () => ({
      command: options.command ?? process.execPath,
      args: [script],
      env: { ...process.env },
    }),
    timeouts: { key: 300 },
  });
};

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
});
