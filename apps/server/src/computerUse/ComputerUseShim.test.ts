// @effect-diagnostics nodeBuiltinImport:off - runs the generated launcher as an agent's shell would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { COMPUTER_CLI_MANUAL } from "./ComputerUseCli.ts";
import { ensureComputerUseShim } from "./ComputerUseShim.ts";

const tempStateDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-shim-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

it.layer(NodeServices.layer)("ComputerUseShim", (it) => {
  it.effect("writes both launchers on Windows, for cmd and for Git Bash", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const shimDir = yield* ensureComputerUseShim({ stateDir }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      assert.deepStrictEqual(NodeFS.readdirSync(shimDir).sort(), [
        "viewcode-computer",
        "viewcode-computer.cmd",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves an up-to-date launcher alone and swaps a stale one in whole", () => {
    const written: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      const [text, fields] = Array.isArray(message) ? message : [message];
      if (text === "computer-use shim written") written.push(fields);
    });
    return Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const shimDir = yield* ensureComputerUseShim({ stateDir });
      const shim = NodePath.join(shimDir, "viewcode-computer");
      const past = 978_307_200; // 2001-01-01, in seconds
      NodeFS.utimesSync(shim, past, past);
      yield* ensureComputerUseShim({ stateDir });
      assert.strictEqual(NodeFS.statSync(shim).mtimeMs, past * 1000);
      // Logged when written, not on every session spawn.
      assert.deepStrictEqual(written, [{ dir: shimDir }]);

      NodeFS.writeFileSync(shim, "#!/bin/sh\nexit 1\n");
      const staleInode = NodeFS.statSync(shim).ino;
      yield* ensureComputerUseShim({ stateDir });
      // Replaced by rename, not rewritten in place under a running shell.
      assert.notStrictEqual(NodeFS.statSync(shim).ino, staleInode);
      assert.include(NodeFS.readFileSync(shim, "utf8"), "ELECTRON_RUN_AS_NODE=1 exec");
      assert.deepStrictEqual(NodeFS.readdirSync(shimDir), ["viewcode-computer"]);
      assert.strictEqual(written.length, 2);
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform; the launcher it runs is a POSIX script.
  it.effect.skipIf(process.platform === "win32")(
    "puts a viewcode-computer on PATH that runs this server's CLI",
    () =>
      Effect.gen(function* () {
        const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-shim-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true })),
        );
        const shimDir = yield* ensureComputerUseShim({ stateDir });
        assert.strictEqual(shimDir, NodePath.join(stateDir, "computer-use", "bin"));

        const result = NodeChildProcess.spawnSync("viewcode-computer", ["help"], {
          env: { ...process.env, PATH: `${shimDir}${NodePath.delimiter}${process.env.PATH ?? ""}` },
          encoding: "utf8",
        });
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, COMPUTER_CLI_MANUAL);
      }).pipe(Effect.scoped),
  );
});
