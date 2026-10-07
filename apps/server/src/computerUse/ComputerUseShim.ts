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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "computer-use/bin";
export const COMPUTER_CLI_NAME = "viewcode-computer";

const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * Sessions spawn concurrently and each ensures the shim: rewrite only when
 * the content differs, and swap it in by rename so no session ever runs a
 * half-written launcher. Returns whether it wrote.
 */
const writeIfChanged = Effect.fnUntraced(function* (target: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined));
  if (current === content) return false;
  const now = yield* Clock.currentTimeMillis;
  const temporary = `${target}.${process.pid}.${now.toString(36)}.tmp`;
  yield* fs.writeFileString(temporary, content);
  yield* fs.chmod(temporary, 0o755);
  yield* fs.rename(temporary, target);
  return true;
});

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

  // Git Bash and other POSIX shells on Windows cannot run a `.cmd` by bare
  // name, so Windows gets both launchers, as npm's cmd-shim does.
  let written = false;
  if (platform === "win32") {
    const quoted = [executable, ...args].map((value) => (value === "--" ? value : `"${value}"`));
    written = yield* writeIfChanged(
      path.join(shimDir, `${COMPUTER_CLI_NAME}.cmd`),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quoted.join(" ")} %*\r\n`,
    );
  }
  const posixWritten = yield* writeIfChanged(
    path.join(shimDir, COMPUTER_CLI_NAME),
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${[executable, ...args].map(shQuote).join(" ")} "$@"\n`,
  );
  if (written || posixWritten) yield* Effect.logInfo("computer-use shim written", { dir: shimDir });
  return shimDir;
});
