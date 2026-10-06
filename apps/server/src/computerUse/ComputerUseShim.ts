/**
 * A directory holding the `viewcode-computer` launcher. Prepended to the
 * PATH of provider subprocesses granted computer use, so the agent runs
 * `viewcode-computer …` from its own shell tool and gets the CLI that matches
 * this server.
 *
 * The launcher runs the CLI under this process's own runtime: the sibling
 * script (TS source in development, `viewcode-computer.mjs` in `dist`) with
 * `ELECTRON_RUN_AS_NODE=1` so the desktop app's Electron binary acts as Node,
 * or the single executable's hidden `__viewcode-computer` subcommand. Using
 * `process.execPath` rather than a `node` on PATH means it works on machines
 * with no Node installed. The CLI is a thin HTTP client; the endpoint and
 * credential arrive in the provider's environment.
 */
import {
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "computer-use/bin";
export const COMPUTER_CLI_NAME = "viewcode-computer";

const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export const ensureComputerUseShim = Effect.fn("ComputerUseShim.ensure")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const executable = yield* HostProcessExecutablePath;
  const isExecutable = yield* HostProcessIsExecutable;
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* fs.makeDirectory(shimDir, { recursive: true });

  const script = isExecutable
    ? undefined
    : yield* path
        .fromFileUrl(
          new URL(
            import.meta.url.endsWith(".ts") ? "../viewcode-computer.ts" : "./viewcode-computer.mjs",
            import.meta.url,
          ),
        )
        .pipe(Effect.orDie);
  const args = script === undefined ? ["__viewcode-computer", "--"] : [script];

  if (platform === "win32") {
    const quoted = [executable, ...args].map((value) => (value === "--" ? value : `"${value}"`));
    yield* fs.writeFileString(
      path.join(shimDir, `${COMPUTER_CLI_NAME}.cmd`),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quoted.join(" ")} %*\r\n`,
    );
  } else {
    const shimPath = path.join(shimDir, COMPUTER_CLI_NAME);
    yield* fs.writeFileString(
      shimPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${[executable, ...args].map(shQuote).join(" ")} "$@"\n`,
    );
    yield* fs.chmod(shimPath, 0o755);
  }
  return shimDir;
});
