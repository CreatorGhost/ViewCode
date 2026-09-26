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

const traceFiles = (dir: string) =>
  NodeFS.readdirSync(dir)
    .filter((name) => name.startsWith(SPAWN_TRACE_FILE_NAME))
    .toSorted();

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
    assert.include(trace, `spawnSync ${JSON.stringify(process.execPath)} <args>`);
    assert.include(trace, "code=3");
    assert.include(trace, `spawn ${JSON.stringify(process.execPath)} <args>`);
    assert.match(trace, /exit .* child=\d+ code=0/);
    assert.notInclude(trace, "secret prompt");
    assert.notInclude(trace, '"-e"');
  });

  it("logs only known subcommand words, and never a shell command's arguments", () => {
    const dir = tempLogDir();
    uninstall = installSpawnTrace(dir);
    NodeChildProcess.spawnSync("/nonexistent/bin/cursor-agent", ["status", "--secret-flag"]);
    NodeChildProcess.spawnSync("/nonexistent/bin/codex", ["exec", "secret prompt"]);
    NodeChildProcess.spawnSync("echo secret-shell-prompt", { shell: true });
    NodeChildProcess.spawnSync('"/no such dir/claude" -p secret-quoted', { shell: true });

    const trace = readTrace(dir);
    assert.include(trace, '"/nonexistent/bin/cursor-agent" status <args> provider=cursor');
    assert.include(trace, '"/nonexistent/bin/codex" <args> provider=codex');
    assert.include(trace, 'spawnSync "echo" <args>');
    assert.include(trace, '"/no such dir/claude" <args> provider=claudeAgent');
    for (const secret of [
      "secret-flag",
      "secret prompt",
      "secret-shell",
      "secret-quoted",
      "exec",
    ]) {
      assert.notInclude(trace, secret);
    }
  });

  it("rotates into .1 and .2 at start and at the size cap, keeping the newest lines", () => {
    const dir = tempLogDir();
    const logPath = NodePath.join(dir, SPAWN_TRACE_FILE_NAME);
    NodeFS.writeFileSync(logPath, "oldest run\n");
    installSpawnTrace(dir)();
    NodeFS.writeFileSync(logPath, "previous run\n");
    uninstall = installSpawnTrace(dir, { maxBytes: 400 });
    assert.strictEqual(NodeFS.readFileSync(`${logPath}.1`, "utf8"), "previous run\n");
    assert.strictEqual(NodeFS.readFileSync(`${logPath}.2`, "utf8"), "oldest run\n");

    for (let index = 0; index < 20; index += 1) {
      NodeChildProcess.spawnSync("/nonexistent/bin/claude", ["--version"]);
    }
    assert.deepStrictEqual(traceFiles(dir), [
      SPAWN_TRACE_FILE_NAME,
      `${SPAWN_TRACE_FILE_NAME}.1`,
      `${SPAWN_TRACE_FILE_NAME}.2`,
    ]);
    for (const name of traceFiles(dir)) {
      assert.isAtMost(NodeFS.statSync(NodePath.join(dir, name)).size, 400);
    }
    const trace = readTrace(dir);
    assert.include(trace, '"/nonexistent/bin/claude" --version provider=claudeAgent');
    assert.notInclude(NodeFS.readFileSync(`${logPath}.2`, "utf8"), "oldest run");
  });

  it("restores the original methods on uninstall", () => {
    const dir = tempLogDir();
    installSpawnTrace(dir)();
    NodeChildProcess.spawnSync(process.execPath, ["-e", "0"]);
    assert.strictEqual(readTrace(dir), "");
  });
});
