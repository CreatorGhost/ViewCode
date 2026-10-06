// @effect-diagnostics nodeBuiltinImport:off - runs the generated launcher as an agent's shell would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { COMPUTER_CLI_MANUAL } from "./ComputerUseCli.ts";
import { ensureComputerUseShim } from "./ComputerUseShim.ts";

it.layer(NodeServices.layer)("ComputerUseShim", (it) => {
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
