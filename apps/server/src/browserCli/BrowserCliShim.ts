/**
 * A directory holding the `viewcode-browser` launcher, prepended to the PATH
 * of provider subprocesses that may use the collaborative browser. Built like
 * the `viewcode-computer` launcher (see `ComputerUseShim.ts`): it runs the
 * CLI under this process's own runtime (`ELECTRON_RUN_AS_NODE=1` for the
 * desktop app), so it works on machines without Node.
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

import { BROWSER_CLI_NAME } from "./browserCliProtocol.ts";

const SHIM_DIR = "browser/bin";

const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Rewrites only on change and swaps in by rename, so concurrent sessions never run a half-written launcher. */
const writeIfChanged = Effect.fnUntraced(function* (target: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined));
  if (current === content) return;
  const now = yield* Clock.currentTimeMillis;
  const temporary = `${target}.${process.pid}.${now.toString(36)}.tmp`;
  yield* fs.writeFileString(temporary, content);
  yield* fs.chmod(temporary, 0o755);
  yield* fs.rename(temporary, target);
});

export const ensureBrowserCliShim = Effect.fn("BrowserCliShim.ensure")(function* (input: {
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
            import.meta.url.endsWith(".ts") ? "../viewcode-browser.ts" : "./viewcode-browser.mjs",
            import.meta.url,
          ),
        )
        .pipe(Effect.orDie);
  const args = script === undefined ? ["__viewcode-browser", "--"] : [script];

  // POSIX shells on Windows cannot run a `.cmd` by bare name, so Windows gets both.
  if (platform === "win32") {
    const quoted = [executable, ...args].map((value) => (value === "--" ? value : `"${value}"`));
    yield* writeIfChanged(
      path.join(shimDir, `${BROWSER_CLI_NAME}.cmd`),
      `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n${quoted.join(" ")} %*\r\n`,
    );
  }
  yield* writeIfChanged(
    path.join(shimDir, BROWSER_CLI_NAME),
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${[executable, ...args].map(shQuote).join(" ")} "$@"\n`,
  );
  return shimDir;
});
