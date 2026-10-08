// @effect-diagnostics nodeBuiltinImport:off - Runs wrangler through npx and streams its output.
/**
 * Runs wrangler for Quick connect setup: `npx --yes wrangler@4 …` from the
 * PATH the server was started with. Without one, a server inside the desktop
 * app runs a downloaded npm's npx under its own Electron binary instead
 * (`bundledNpm.ts`), so the desktop needs no Node.js install; anywhere else a
 * missing Node is a message. Every run trusts the OS certificate store
 * (`--use-system-ca`) so a TLS-inspecting corporate proxy does not break
 * wrangler, and gets a staged copy of the Worker to deploy. The child is
 * killed through its captured handle when the run is interrupted.
 */
import * as NodeChildProcess from "node:child_process";

import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { WRANGLER_PACKAGE } from "@t3tools/shared/viewcodeRelaySetup";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import { ensureBundledNpm, nodeShim, NPX_CLI_PATH } from "./bundledNpm.ts";
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
      /** The Cloudflare account to act on (`CLOUDFLARE_ACCOUNT_ID`), when the sign-in has several. */
      readonly accountId?: string;
    },
  ) => Effect.Effect<WranglerResult>;
}

/**
 * Finds Node and npx (downloading npm on a desktop without them, while
 * `showProgress` says so), stages the Worker; the staged folder goes away
 * with the scope.
 */
export type PrepareWrangler = (
  showProgress: (message: string) => Effect.Effect<void>,
) => Effect.Effect<
  WranglerSession,
  RelaySetupFailure,
  Scope.Scope | FileSystem.FileSystem | Path.Path
>;

export const NODE_MISSING_MESSAGE =
  "Quick connect setup needs Node.js (nodejs.org). Install it, then try again.";
const NODE_TOO_OLD_MESSAGE =
  "Quick connect setup needs Node.js 22 or newer (nodejs.org). Update it, then try again.";
const DESKTOP_NODE_TOO_OLD_MESSAGE =
  "This version of ViewCode cannot run Cloudflare's tools by itself. Install Node.js 22 or newer (nodejs.org), or update ViewCode, then try again.";
/** Shown while the one-time npm download runs. */
export const TOOL_DOWNLOAD_MESSAGE = "Getting the Cloudflare tool ready…";
/** wrangler 4 refuses older Node. */
const WRANGLER_MIN_NODE_MAJOR = 22;
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

export type NpxChoice =
  | { readonly kind: "system"; readonly nodeVersion: readonly [number, number] }
  /** Inside the desktop app, without a usable Node: its Electron is a recent enough Node. */
  | { readonly kind: "bundled"; readonly nodeVersion: readonly [number, number] }
  /** The installed Node is too old, and the desktop's cannot stand in. */
  | { readonly kind: "system-too-old"; readonly found: string }
  /** No usable Node, inside a desktop app whose Electron's Node is too old for wrangler. */
  | { readonly kind: "desktop-too-old"; readonly nodeVersion: string }
  | { readonly kind: "missing" };

/**
 * Where npx comes from. A system npx with a recent Node always wins, so
 * `npx t3` and desktop users with Node keep today's behaviour.
 * `systemNode` is what `node --version` printed when npx is on PATH, else
 * null; `desktopNodeVersion` is `process.versions.node` under Electron, else null.
 */
export function chooseNpx(input: {
  readonly systemNode: string | null;
  readonly desktopNodeVersion: string | null;
}): NpxChoice {
  const system = input.systemNode === null ? null : parseNodeVersion(input.systemNode);
  if (system !== null && system[0] >= WRANGLER_MIN_NODE_MAJOR) {
    return { kind: "system", nodeVersion: system };
  }
  const desktop =
    input.desktopNodeVersion === null ? null : parseNodeVersion(input.desktopNodeVersion);
  if (desktop !== null && desktop[0] >= WRANGLER_MIN_NODE_MAJOR) {
    return { kind: "bundled", nodeVersion: desktop };
  }
  if (system !== null) return { kind: "system-too-old", found: input.systemNode!.trim() };
  if (input.desktopNodeVersion !== null) {
    return { kind: "desktop-too-old", nodeVersion: input.desktopNodeVersion };
  }
  return { kind: "missing" };
}

/** How each wrangler run starts. */
export type NpxLaunch =
  | { readonly kind: "system" }
  /** The downloaded npm's `npx-cli.js`, run by this Electron binary as Node. */
  | { readonly kind: "bundled"; readonly executable: string; readonly npxCli: string };

export function wranglerCommand(
  launch: NpxLaunch,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const npxArgs = ["--yes", WRANGLER_PACKAGE, ...args];
  return launch.kind === "system"
    ? { command: "npx", args: npxArgs }
    : { command: launch.executable, args: [launch.npxCli, ...npxArgs] };
}

/**
 * The environment of every wrangler run. With the bundled npm, Electron runs
 * as Node and `shimDir` (holding the `node` shim) comes first on PATH, for
 * everything below npx that starts `node` by name.
 */
export function wranglerEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly nodeVersion: readonly [number, number];
  readonly platform: NodeJS.Platform;
  readonly shimDir?: string | undefined;
}): NodeJS.ProcessEnv {
  const { env, shimDir } = input;
  // A Node before 22.15 rejects the flag in NODE_OPTIONS and would not start at
  // all; it runs with Node's bundled roots instead (a TLS-inspecting proxy may
  // then fail it, and the details show why).
  const inherited = env.NODE_OPTIONS?.trim();
  const nodeOptions = [
    supportsSystemCa(input.nodeVersion) ? "--use-system-ca" : "",
    inherited ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  const result: NodeJS.ProcessEnv = {
    ...env,
    ...(nodeOptions === "" ? {} : { NODE_OPTIONS: nodeOptions }),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    WRANGLER_SEND_METRICS: "false",
  };
  if (shimDir === undefined) return result;
  // Windows spells it `Path`; npm merges every spelling, so extend the one there is.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const current = env[pathKey];
  const delimiter = input.platform === "win32" ? ";" : ":";
  return {
    ...result,
    ELECTRON_RUN_AS_NODE: "1",
    [pathKey]:
      current === undefined || current === "" ? shimDir : `${shimDir}${delimiter}${current}`,
  };
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

/**
 * The real runner: npx from PATH, or on a desktop without it the bundled npm
 * cached under `cacheDir`; the Worker staged into a temporary folder.
 */
export const prepareNodeWrangler =
  (input: { readonly here: string; readonly cacheDir: string }): PrepareWrangler =>
  (showProgress) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = process.env;
      const platform = yield* HostProcessPlatform;
      const executable = yield* HostProcessExecutablePath;
      const tempDir = (prefix: string) =>
        fs.makeTempDirectoryScoped({ prefix }).pipe(
          Effect.mapError(
            () =>
              new RelaySetupFailure({
                message: "Could not create a temporary folder for the relay.",
              }),
          ),
        );
      const tmp = yield* tempDir("viewcode-relay-");

      const npx = yield* resolveCommandPath("npx", { env }).pipe(Effect.option);
      const systemNode =
        npx._tag === "None"
          ? null
          : yield* spawnAndCollect({ command: "node", args: ["--version"], cwd: tmp, env });
      const choice = chooseNpx({
        systemNode: systemNode?.exitCode === 0 ? systemNode.output : null,
        desktopNodeVersion: process.versions.electron === undefined ? null : process.versions.node,
      });
      if (choice.kind === "missing") {
        return yield* new RelaySetupFailure({
          message: NODE_MISSING_MESSAGE,
          action: "install-node",
        });
      }
      if (choice.kind === "system-too-old") {
        return yield* new RelaySetupFailure({
          message: NODE_TOO_OLD_MESSAGE,
          details: `Found Node.js ${choice.found}.`,
          action: "install-node",
        });
      }
      if (choice.kind === "desktop-too-old") {
        return yield* new RelaySetupFailure({
          message: DESKTOP_NODE_TOO_OLD_MESSAGE,
          details: `ViewCode runs Node.js ${choice.nodeVersion}; Cloudflare's tools need ${WRANGLER_MIN_NODE_MAJOR} or newer.`,
          action: "install-node",
        });
      }

      let launch: NpxLaunch = { kind: "system" };
      let shimDir: string | undefined;
      if (choice.kind === "bundled") {
        // A failed download ends where a missing Node always did: install Node.js.
        const npmDir = yield* ensureBundledNpm({
          cacheDir: input.cacheDir,
          onDownload: showProgress(TOOL_DOWNLOAD_MESSAGE),
        }).pipe(
          Effect.mapError(
            (details) =>
              new RelaySetupFailure({
                message: NODE_MISSING_MESSAGE,
                details,
                action: "install-node",
              }),
          ),
        );
        shimDir = yield* tempDir("viewcode-node-");
        const shim = nodeShim(platform, executable);
        yield* fs
          .writeFileString(path.join(shimDir, shim.fileName), shim.content, { mode: 0o755 })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RelaySetupFailure({
                  message: "Could not prepare Cloudflare's tools on this computer.",
                  details: String(cause),
                }),
            ),
          );
        launch = {
          kind: "bundled",
          executable,
          npxCli: path.join(npmDir, ...NPX_CLI_PATH),
        };
      }

      const files = yield* findRelayWorkerFiles(input.here);
      if (files === null) return yield* new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE });
      const configPath = yield* stageRelayWorker(files, tmp).pipe(
        Effect.mapError(
          (cause) =>
            new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE, details: String(cause) }),
        ),
      );

      const wranglerEnv = wranglerEnvironment({
        env,
        nodeVersion: choice.nodeVersion,
        platform,
        shimDir,
      });
      const session: WranglerSession = {
        configPath,
        run: (args, options) => {
          const command = wranglerCommand(launch, args);
          return spawnAndCollect({
            command: command.command,
            args: command.args,
            cwd: tmp,
            env:
              options?.accountId === undefined
                ? wranglerEnv
                : { ...wranglerEnv, CLOUDFLARE_ACCOUNT_ID: options.accountId },
            stdin: options?.input,
            onOutput: options?.onOutput,
          });
        },
      };
      return session;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RelaySetupFailure
          ? cause
          : new RelaySetupFailure({ message: WORKER_MISSING_MESSAGE, details: String(cause) }),
      ),
    );
