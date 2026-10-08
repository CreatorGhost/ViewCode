// @effect-diagnostics nodeBuiltinImport:off - runs the generated launcher as an agent's shell would.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { BROWSER_CLI_MANUAL } from "./BrowserCli.ts";
import { ensureBrowserCliShim } from "./BrowserCliShim.ts";

const tempStateDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-shim-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

it.layer(NodeServices.layer)("BrowserCliShim", (it) => {
  it.effect("writes both launchers on Windows, for cmd and for Git Bash", () =>
    Effect.gen(function* () {
      const stateDir = yield* tempStateDir;
      const shimDir = yield* ensureBrowserCliShim({ stateDir }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
      );
      assert.deepStrictEqual(NodeFS.readdirSync(shimDir).sort(), [
        "viewcode-browser",
        "viewcode-browser.cmd",
      ]);
    }).pipe(Effect.scoped),
  );

  // oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform; the launcher it runs is a POSIX script.
  it.effect.skipIf(process.platform === "win32")(
    "puts a viewcode-browser on PATH that runs this server's CLI",
    () =>
      Effect.gen(function* () {
        const stateDir = yield* tempStateDir;
        const shimDir = yield* ensureBrowserCliShim({ stateDir });
        assert.strictEqual(shimDir, NodePath.join(stateDir, "browser", "bin"));
        const result = NodeChildProcess.spawnSync("viewcode-browser", ["help"], {
          env: { ...process.env, PATH: `${shimDir}${NodePath.delimiter}${process.env.PATH ?? ""}` },
          encoding: "utf8",
        });
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, BROWSER_CLI_MANUAL);
      }).pipe(Effect.scoped),
  );
});
