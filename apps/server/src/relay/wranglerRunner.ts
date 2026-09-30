// @effect-diagnostics nodeBuiltinImport:off - Runs wrangler through npx and streams its output.
/**
 * Runs wrangler for Quick connect setup: `npx --yes wrangler@4 …` from the
 * PATH the server was started with (the server may itself run under
 * Electron-as-node, so it never uses its own executable). Every run trusts the
 * OS certificate store (`--use-system-ca`) so a TLS-inspecting corporate proxy
 * does not break wrangler, and gets a staged copy of the Worker to deploy.
 * The child is killed through its captured handle when the run is interrupted.
 */
import * as NodeChildProcess from "node:child_process";

import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { WRANGLER_PACKAGE } from "@t3tools/shared/viewcodeRelaySetup";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { findRelayWorkerFiles, stageRelayWorker } from "./relayWorkerSource.ts";

/**
 * A setup step that cannot continue. `message` is one plain sentence for the
 * person; `details` is redacted tool output for a collapsed "Details".
 */
export class RelaySetupFailure extends Data.TaggedError("RelaySetupFailure")<{
  readonly message: string;
  readonly details?: string;
  readonly action?: "install-node";
}> {}

export interface WranglerResult {
  readonly exitCode: number;
  /** stdout and stderr interleaved, as printed. */
  readonly output: string;
}

export interface WranglerSession {
  /** The generated config of the staged Worker; pass it with `--config`. */
  readonly configPath: string;
  readonly run: (
    args: ReadonlyArray<string>,
    options?: {
      /** Written to stdin, then stdin closes. The only way the host secret reaches wrangler. */
      readonly input?: string;
      /** Each chunk of output as it arrives. */
      readonly onOutput?: (text: string) => void;
    },
  ) => Effect.Effect<WranglerResult>;
}

/** Finds Node and npx, stages the Worker; the staged folder goes away with the scope. */
export type PrepareWrangler = Effect.Effect<
  WranglerSession,
  RelaySetupFailure,
  Scope.Scope | FileSystem.FileSystem | Path.Path
>;

export const NODE_MISSING_MESSAGE =
  "Quick connect setup needs Node.js (nodejs.org). Install it, then try again.";
const NODE_TOO_OLD_MESSAGE =
  "Quick connect setup needs Node.js 22 or newer (nodejs.org). Update it, then try again.";
const WORKER_MISSING_MESSAGE =
  "This build of ViewCode does not include the Quick connect relay. Update ViewCode, then try again.";

/** Keeps the tail of long output; the start of a wrangler run is banners. */
const MAX_OUTPUT_CHARS = 64_000;

/** `v22.15.1` → [22, 15]; null when unreadable. */
export function parseNodeVersion(text: string): readonly [number, number] | null {
  const match = /v?(\d+)\.(\d+)\.\d+/u.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** `--use-system-ca` exists (and is allowed in NODE_OPTIONS) from Node 22.15 / 23.8. */
export function supportsSystemCa([major, minor]: readonly [number, number]): boolean {
  return major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
}

const spawnAndCollect = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string | undefined;
  readonly onOutput?: ((text: string) => void) | undefined;
}): Effect.Effect<WranglerResult> =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(input.command, input.args, { env: input.env });
    return yield* Effect.callback<WranglerResult>((resume) => {
      let output = "";
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(spawn.command, spawn.args, {
          cwd: input.cwd,
          env: input.env,
          shell: spawn.shell,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (cause) {
        resume(Effect.succeed({ exitCode: 127, output: String(cause) }));
        return;
      }
      const collect = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output = (output + text).slice(-MAX_OUTPUT_CHARS);
        input.onOutput?.(text);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input.stdin ?? "");
      child.once("error", (cause) =>
        resume(Effect.succeed({ exitCode: 127, output: `${output}${String(cause)}` })),
      );
      child.once("close", (code) => resume(Effect.succeed({ exitCode: code ?? 1, output })));
      // Interrupted (Cancel, or the server stopping): end the child we spawned.
      return Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
    });
  }).pipe(Effect.orElseSucceed(() => ({ exitCode: 127, output: "" })));

/** The real runner: npx from PATH, the Worker staged into a temporary folder. */
export const prepareNodeWrangler = (here: string): PrepareWrangler =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = process.env;
    const npx = yield* resolveCommandPath("npx", { env }).pipe(Effect.option);
    if (npx._tag === "None") {
      return yield* new RelaySetupFailure({
        message: NODE_MISSING_MESSAGE,
        action: "install-node",
      });
    }
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-relay-" }).pipe(
      Effect.mapError(
        () =>
          new RelaySetupFailure({
            message: "Could not create a temporary folder for the relay.",
          }),
      ),
    );
    const nodeVersion = yield* spawnAndCollect({
      command: "node",
      args: ["--version"],
      cwd: tmp,
      env,
    });
    const version = nodeVersion.exitCode === 0 ? parseNodeVersion(nodeVersion.output) : null;
    if (version === null) {
      return yield* new RelaySetupFailure({
        message: NODE_MISSING_MESSAGE,
        action: "install-node",
      });
    }
    if (version[0] < 22) {
      return yield* new RelaySetupFailure({
        message: NODE_TOO_OLD_MESSAGE,
        details: `Found Node.js ${nodeVersion.output.trim()}.`,
        action: "install-node",
      });
    }

    const files = yield* findRelayWorkerFiles(here);
    if (files === null) return yield* new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE });
    const configPath = yield* stageRelayWorker(files, tmp).pipe(
      Effect.mapError(
        (cause) =>
          new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE, details: String(cause) }),
      ),
    );

    // A Node before 22.15 rejects the flag in NODE_OPTIONS and would not start at
    // all; it runs with Node's bundled roots instead (a TLS-inspecting proxy may
    // then fail it, and the details show why).
    const inherited = env.NODE_OPTIONS?.trim();
    const nodeOptions = [supportsSystemCa(version) ? "--use-system-ca" : "", inherited ?? ""]
      .filter((part) => part !== "")
      .join(" ");
    const wranglerEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(nodeOptions === "" ? {} : { NODE_OPTIONS: nodeOptions }),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      WRANGLER_SEND_METRICS: "false",
    };
    const session: WranglerSession = {
      configPath,
      run: (args, options) =>
        spawnAndCollect({
          command: "npx",
          args: ["--yes", WRANGLER_PACKAGE, ...args],
          cwd: tmp,
          env: wranglerEnv,
          stdin: options?.input,
          onOutput: options?.onOutput,
        }),
    };
    return session;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RelaySetupFailure
        ? cause
        : new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE, details: String(cause) }),
    ),
  );
