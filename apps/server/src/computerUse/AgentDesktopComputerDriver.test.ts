// @effect-diagnostics nodeBuiltinImport:off - writes a stub helper script for the real child-process client.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll } from "vite-plus/test";

import { agentDesktopBinary, agentDesktopSelected } from "./AgentDesktopComputerDriver.ts";
import { makeXa11yComputerDriver } from "./Xa11yComputerDriver.ts";

// Stands in for the native helper: the same requests, as JSON lines on stdio.
const STUB_HELPER = `
const readline = require("node:readline");
const nonce = process.env.VIEWCODE_COMPUTER_DRIVER_NONCE;
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, nonce: sent, request } = JSON.parse(line);
  if (sent !== nonce) return process.exit(2);
  switch (request.op) {
    case "status":
      return say({ id, ok: true, result: { available: true, accessibility: "granted" } });
    case "listWindows":
      return say({ id, ok: true, result: [
        { handle: "wab.1", app: "Notes", pid: process.pid, title: "List", focused: true },
      ] });
    case "observe":
      return process.stdout.write("not json\\n");
    default:
      return say({ id, ok: false, error: { kind: "unavailable", message: "observe only", dispatched: "no" } });
  }
});
`;

const stubDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-desktop-"));
afterAll(() => NodeFS.rmSync(stubDirectory, { recursive: true, force: true }));

const makeDriver = (command = process.execPath) => {
  const script = NodePath.join(stubDirectory, "stub-helper.cjs");
  NodeFS.writeFileSync(script, STUB_HELPER);
  return makeXa11yComputerDriver({
    platform: "darwin",
    launch: () => ({
      command,
      args: [script],
      env: { ...process.env },
      host: "native",
      transport: "stdio",
    }),
  });
};

describe("AgentDesktopComputerDriver", () => {
  it.effect("talks to a native helper in JSON lines over stdio", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        assert.deepStrictEqual(yield* driver.status(), {
          available: true,
          accessibility: "granted",
        });
        const windows = yield* driver.listWindows();
        assert.strictEqual(windows[0]?.app, "Notes");
        const refused = yield* Effect.flip(driver.press("eab.1", { role: "button", label: "OK" }));
        assert.deepStrictEqual(
          { kind: refused.kind, dispatched: refused.dispatched },
          { kind: "unavailable", dispatched: "no" },
        );
      }),
    ),
  );

  it.effect("answers a line that is not JSON as malformed, then starts a fresh helper", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const first = (yield* driver.listWindows())[0]?.pid;
        const malformed = yield* Effect.flip(driver.observe("wab.1", { maxElements: 10 }));
        assert.strictEqual(malformed.kind, "malformed");
        const second = (yield* driver.listWindows())[0]?.pid;
        assert.notStrictEqual(second, first);
      }),
    ),
  );

  it.effect("a helper that is not built leaves status unavailable instead of failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = yield* makeDriver(NodePath.join(stubDirectory, "missing-helper"));
        assert.strictEqual((yield* driver.status()).available, false);
        const refused = yield* Effect.flip(driver.listWindows());
        assert.deepStrictEqual(
          { kind: refused.kind, dispatched: refused.dispatched },
          { kind: "unavailable", dispatched: "no" },
        );
      }),
    ),
  );

  it("is chosen only by its exact name", () => {
    assert.isTrue(agentDesktopSelected(" Agent-Desktop "));
    assert.isFalse(agentDesktopSelected(""));
    assert.isFalse(agentDesktopSelected("xa11y"));
  });

  it("uses the helper a source checkout builds unless a path is given", () => {
    const moduleUrl = "file:///repo/apps/server/src/computerUse/AgentDesktopComputerDriver.ts";
    assert.strictEqual(
      agentDesktopBinary("darwin", "", moduleUrl),
      "/repo/native/computer-driver/target/release/viewcode-computer-driver",
    );
    assert.strictEqual(agentDesktopBinary("darwin", " /opt/helper ", moduleUrl), "/opt/helper");
  });
});
