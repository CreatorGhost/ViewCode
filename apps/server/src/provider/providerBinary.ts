/**
 * Never exec a provider binary that can't be found.
 *
 * Provider health checks used to learn "not installed" only from `spawn`
 * failing with ENOENT. On EDR-managed machines the attempt itself is scored,
 * so a check now resolves the command on the filesystem first and, when it is
 * absent, fails the spawn with the same `NotFound` error Node would have
 * produced. Each provider's existing ENOENT handling then builds its normal
 * "not installed" snapshot without a process ever being started.
 *
 * @module provider/providerBinary
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";

function commandLookupEnv(options: ChildProcess.CommandOptions): NodeJS.ProcessEnv {
  if (!options.env) return process.env;
  return options.extendEnv ? { ...process.env, ...options.env } : options.env;
}

function hasPathVariable(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.toUpperCase() === "PATH" && Boolean(env[key]));
}

/**
 * Whether the guard can answer for this command without guessing. Shell
 * commands, cwd-relative paths and environments without PATH resolve
 * differently at spawn time, so those are left to the real spawner.
 */
function isGuardable(command: ChildProcess.StandardCommand): boolean {
  if (command.options.shell) return false;
  const name = command.command;
  if (name.length === 0) return false;
  const hasSeparator = name.includes("/") || name.includes("\\");
  if (hasSeparator) {
    return name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith("\\\\");
  }
  return hasPathVariable(commandLookupEnv(command.options));
}

/** Resolve a provider command (configured path or PATH lookup), filesystem only. */
export const resolveProviderBinary = (
  command: string,
  env: NodeJS.ProcessEnv,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  resolveCommandPath(command, { env }).pipe(
    Effect.catchTag("CommandResolutionError", () => Effect.succeed(null)),
  );

/**
 * Wrap the spawner a provider health check uses so a command that doesn't
 * exist fails like ENOENT instead of being executed. A command that resolves
 * runs by its resolved path (POSIX), so what was checked is what runs.
 */
export function guardMissingProviderBinary(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || !isGuardable(command)) {
      return spawner.spawn(command);
    }
    return Effect.gen(function* () {
      const resolved = yield* resolveProviderBinary(
        command.command,
        commandLookupEnv(command.options),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (resolved === null) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: command.command,
          description: `Provider command not found; not executed: ${command.command}`,
        });
      }
      const platform = yield* HostProcessPlatform;
      return yield* spawner.spawn(
        platform === "win32" || resolved === command.command
          ? command
          : ChildProcess.make(resolved, command.args, command.options),
      );
    });
  });
}

/**
 * OpenCode's runtime holds its own spawner, so its health check is guarded at
 * the runtime methods instead. The failure carries "ENOENT" in its detail so
 * the check reports the provider as not installed, as a real ENOENT would.
 */
export function guardMissingOpenCodeBinary(
  runtime: OpenCodeRuntimeShape,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
): OpenCodeRuntimeShape {
  const requireBinary = (operation: string, binaryPath: string, env?: NodeJS.ProcessEnv) =>
    resolveProviderBinary(binaryPath, env ?? process.env).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.flatMap((resolved) =>
        resolved === null
          ? Effect.fail(
              new OpenCodeRuntimeError({
                operation,
                detail: `spawn ${binaryPath} ENOENT (not found; not executed)`,
              }),
            )
          : Effect.void,
      ),
    );
  return {
    ...runtime,
    runOpenCodeCommand: (input) =>
      requireBinary("runOpenCodeCommand", input.binaryPath, input.environment).pipe(
        Effect.andThen(runtime.runOpenCodeCommand(input)),
      ),
    startOpenCodeServerProcess: (input) =>
      requireBinary("startOpenCodeServerProcess", input.binaryPath, input.environment).pipe(
        Effect.andThen(runtime.startOpenCodeServerProcess(input)),
      ),
    connectToOpenCodeServer: (input) =>
      input.serverUrl
        ? runtime.connectToOpenCodeServer(input)
        : requireBinary("connectToOpenCodeServer", input.binaryPath, input.environment).pipe(
            Effect.andThen(runtime.connectToOpenCodeServer(input)),
          ),
  };
}
