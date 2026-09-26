// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "@effect/vitest";

import { installSpawnTrace, SPAWN_TRACE_FILE_NAME } from "./spawnTrace.ts";

const tempLogDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-spawn-trace-"));
let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

const readTrace = (dir: string) =>
  NodeFS.readFileSync(NodePath.join(dir, SPAWN_TRACE_FILE_NAME), "utf8");

describe("installSpawnTrace", () => {
  it("logs spawns made through ESM imports, with exit codes and no payloads", async () => {
    const dir = tempLogDir();
    NodeFS.writeFileSync(NodePath.join(dir, SPAWN_TRACE_FILE_NAME), "previous run\n");
    uninstall = installSpawnTrace(dir);

    NodeChildProcess.spawnSync(process.execPath, ["-e", "process.exit(3) // secret prompt"]);
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));

    const trace = readTrace(dir);
    assert.notInclude(trace, "previous run");
    assert.include(trace, `spawnSync ${JSON.stringify(process.execPath)} "-e"`);
    assert.include(trace, "code=3");
    assert.include(trace, `spawn ${JSON.stringify(process.execPath)} "-e"`);
    assert.match(trace, /exit .* child=\d+ code=0/);
    assert.notInclude(trace, "secret prompt");
  });

  it("names provider CLIs and stops at the size cap", () => {
    const dir = tempLogDir();
    uninstall = installSpawnTrace(dir, { maxBytes: 400 });
    for (let index = 0; index < 20; index += 1) {
      NodeChildProcess.spawnSync("/nonexistent/bin/claude", ["--version"]);
    }
    const trace = readTrace(dir);
    assert.include(trace, "provider=claudeAgent");
    assert.include(trace, "trace stopped at 400 bytes");
    assert.isAtMost(Buffer.byteLength(trace), 500);
  });

  it("restores the original methods on uninstall", () => {
    const dir = tempLogDir();
    installSpawnTrace(dir)();
    NodeChildProcess.spawnSync(process.execPath, ["-e", "0"]);
    assert.strictEqual(readTrace(dir), "");
  });
});
