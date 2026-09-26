// @effect-diagnostics nodeBuiltinImport:off
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
 * The rule fails closed: a command the guard cannot resolve with certainty
 * (piped commands, a POSIX shell string, an environment without PATH) is
 * treated as not installed rather than executed. Resolution uses the
 * uncached, synchronous filesystem lookup, so a binary removed a moment ago
 * is not launched from a stale cache, and what runs is the resolved path.
 *
 * @module provider/providerBinary
 */
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodePath from "node:path";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";

/** The environment a spawn with these options sees (Node's rules). */
function effectiveEnv(
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly extendEnv?: boolean | undefined;
  },
  hostEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!options.env) return hostEnv;
  return options.extendEnv ? { ...hostEnv, ...options.env } : options.env;
}

function hasPathVariable(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.toUpperCase() === "PATH" && Boolean(env[key]));
}

/**
 * Undo `resolveSpawnCommand`'s Windows shell escaping (cmd.exe carets, outer
 * quotes, backslash doubling) to recover the `.cmd`/`.bat` path it wrapped.
 */
export function unescapeWindowsShellCommand(command: string): string {
  let value = command.replace(/\^(.)/g, "$1");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
    value = value.replace(/(\\+)$/, (slashes) => slashes.slice(0, slashes.length / 2));
    value = value.replace(
      /(\\*)\\"/g,
      (_match, slashes: string) => `${slashes.slice(0, slashes.length / 2)}"`,
    );
  }
  return value;
}

/**
 * Resolve a provider command to the executable file that would run, by an
 * uncached filesystem lookup: a path (absolute, or relative to `cwd`) must be
 * an executable file; a bare name is looked up on the environment's PATH.
 * `null` when it does not resolve, including when there is no PATH to search.
 */
export const resolveProviderBinary = Effect.fn("resolveProviderBinary")(function* (
  command: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string | null> {
  const name = command.trim();
  if (name.length === 0) return null;
  const platform = yield* HostProcessPlatform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const hasSeparator = name.includes("/") || name.includes("\\");
  if (hasSeparator) {
    const base = cwd ?? (yield* HostProcessWorkingDirectory);
    const absolute = pathApi.isAbsolute(name) ? name : pathApi.resolve(base, name);
    return resolveExecutable(absolute, platform, env) ?? null;
  }
  if (!hasPathVariable(env)) return null;
  return resolveExecutable(name, platform, env) ?? null;
});

const notFound = (command: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: command,
    description: `Provider command not found or not resolvable; not executed: ${command}`,
  });

/**
 * Wrap the spawner a provider health check uses so a command that doesn't
 * resolve fails like ENOENT instead of being executed, and a command that does
 * runs by its resolved path.
 */
export function guardMissingProviderBinary(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") {
        return yield* notFound("<piped command>");
      }
      const platform = yield* HostProcessPlatform;
      const env = effectiveEnv(command.options, yield* HostProcessEnvironment);
      const cwd = command.options.cwd;
      if (command.options.shell) {
        // Only the Windows launcher-script wrapping from `resolveSpawnCommand`
        // is understood: validate the script it names, then run it as wrapped.
        if (platform !== "win32") return yield* notFound(command.command);
        const script = unescapeWindowsShellCommand(command.command);
        const resolved = yield* resolveProviderBinary(script, env, cwd);
        if (resolved === null) return yield* notFound(script);
        return yield* spawner.spawn(command);
      }
      const resolved = yield* resolveProviderBinary(command.command, env, cwd);
      if (resolved === null) return yield* notFound(command.command);
      return yield* spawner.spawn(
        resolved === command.command
          ? command
          : ChildProcess.make(resolved, command.args, command.options),
      );
    }),
  );
}

/**
 * OpenCode's runtime holds its own spawner, so it is guarded at its launch
 * methods; the driver builds its server owner, adapter and health check with
 * the guarded runtime. The failure carries "ENOENT" so callers report the
 * provider as not installed, as a real ENOENT would.
 */
export function guardMissingOpenCodeBinary(runtime: OpenCodeRuntimeShape): OpenCodeRuntimeShape {
  const requireBinary = (
    operation: string,
    binaryPath: string,
    env: NodeJS.ProcessEnv | undefined,
    cwd?: string,
  ) =>
    Effect.gen(function* () {
      return yield* resolveProviderBinary(binaryPath, env ?? (yield* HostProcessEnvironment), cwd);
    }).pipe(
      Effect.flatMap((resolved) =>
        resolved === null
          ? Effect.fail(
              new OpenCodeRuntimeError({
                operation,
                detail: `spawn ${binaryPath} ENOENT (not found; not executed)`,
              }),
            )
          : Effect.succeed(resolved),
      ),
    );
  return {
    ...runtime,
    runOpenCodeCommand: (input) =>
      requireBinary("runOpenCodeCommand", input.binaryPath, input.environment, input.cwd).pipe(
        Effect.flatMap((binaryPath) => runtime.runOpenCodeCommand({ ...input, binaryPath })),
      ),
    startOpenCodeServerProcess: (input) =>
      requireBinary("startOpenCodeServerProcess", input.binaryPath, input.environment).pipe(
        Effect.flatMap((binaryPath) =>
          runtime.startOpenCodeServerProcess({ ...input, binaryPath }),
        ),
      ),
    connectToOpenCodeServer: (input) =>
      input.serverUrl
        ? runtime.connectToOpenCodeServer(input)
        : requireBinary("connectToOpenCodeServer", input.binaryPath, input.environment).pipe(
            Effect.flatMap((binaryPath) =>
              runtime.connectToOpenCodeServer({ ...input, binaryPath }),
            ),
          ),
    loadInventoryFromCli: (input) =>
      requireBinary("loadInventoryFromCli", input.binaryPath, input.environment, input.cwd).pipe(
        Effect.flatMap((binaryPath) => runtime.loadInventoryFromCli({ ...input, binaryPath })),
      ),
    loadSkillsFromCli: (input) =>
      requireBinary("loadSkillsFromCli", input.binaryPath, input.environment, input.cwd).pipe(
        Effect.flatMap((binaryPath) => runtime.loadSkillsFromCli({ ...input, binaryPath })),
      ),
  };
}

/**
 * Build a provider instance with guarded launch services: its spawner and, for
 * OpenCode, its runtime. Drivers capture these while being created, so
 * health checks, sessions, text generation and maintenance lookups all go
 * through the guard. Services missing from the context are left alone.
 */
export const withProviderLaunchGuard = <A, E, R>(
  create: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const openCodeRuntime = yield* Effect.serviceOption(OpenCodeRuntime);
    let guarded = create;
    if (Option.isSome(spawner)) {
      guarded = guarded.pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          guardMissingProviderBinary(spawner.value),
        ),
      );
    }
    if (Option.isSome(openCodeRuntime)) {
      guarded = guarded.pipe(
        Effect.provideService(OpenCodeRuntime, guardMissingOpenCodeBinary(openCodeRuntime.value)),
      );
    }
    return yield* guarded;
  });
