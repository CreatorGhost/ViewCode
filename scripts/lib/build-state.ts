// @effect-diagnostics nodeBuiltinImport:off - The build bootstrap inspects paths and open files before launching the app.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { loadRepoEnv } from "./public-config.ts";

/** Resolve the same home as the launcher, without exporting repo secrets to the shell. */
export async function resolveBuildState({
  mode,
  repoRoot,
  baseEnv = process.env,
  homeDirectory = NodeOS.homedir(),
  platform = Effect.runSync(HostProcessPlatform),
}: {
  mode: "web" | "desktop";
  repoRoot: string;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}) {
  const env = mode === "web" ? loadRepoEnv({ baseEnv, repoRoot }) : baseEnv;
  const worktreeHome =
    mode === "web"
      ? await Effect.runPromise(
          resolveWorktreeT3Home(repoRoot).pipe(Effect.provide(NodeServices.layer)),
        )
      : undefined;
  const configuredHome = worktreeHome ?? (env.T3CODE_HOME?.trim() || undefined);
  const launchDirectory = mode === "web" ? repoRoot : NodePath.join(repoRoot, "apps/desktop");
  const baseDir = NodePath.resolve(
    launchDirectory,
    configuredHome ?? NodePath.join(homeDirectory, ".viewcode"),
  );
  const isDevelopment = mode === "web" || Boolean(env.VITE_DEV_SERVER_URL?.trim());
  const stateDir = NodePath.join(baseDir, isDevelopment && !configuredHome ? "dev" : "userdata");
  const appData =
    platform === "darwin"
      ? NodePath.join(homeDirectory, "Library/Application Support")
      : platform === "win32"
        ? (baseEnv.APPDATA ?? NodePath.join(homeDirectory, "AppData/Roaming"))
        : (baseEnv.XDG_CONFIG_HOME ?? NodePath.join(homeDirectory, ".config"));
  const profileDir = NodePath.resolve(
    launchDirectory,
    appData,
    mode === "desktop" && isDevelopment ? "viewcode-dev" : "viewcode",
  );
  return { baseDir, stateDir, profileDir };
}

/** Refuse to move any directory whose contents are open, regardless of process name or cwd. */
export function assertBuildStateIdle(
  directories: readonly string[],
  inspect: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number },
  ) => Pick<
    NodeChildProcess.SpawnSyncReturns<string>,
    "error" | "signal" | "stdout" | "stderr" | "status"
  > = NodeChildProcess.spawnSync,
) {
  for (const directory of new Set(directories)) {
    let canonical: string;
    try {
      canonical = NodeFS.realpathSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!NodeFS.statSync(canonical).isDirectory()) {
      throw new Error(
        `Cannot inspect ${directory}: expected a data directory; not moving anything.`,
      );
    }
    // -x must precede +D: lsof builds the recursive file list while parsing it.
    // Follow nested symlinks and mount points too. Any diagnostic means the
    // scan may be incomplete, even when lsof reports its usual no-match exit 1.
    const result = inspect("lsof", ["-x", "-nP", "-Fpn", "+D", canonical], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error || result.signal || result.stderr || ![0, 1].includes(result.status ?? -1)) {
      throw new Error(
        `Cannot check open files in ${directory}; not moving anything. Ensure lsof is installed and can inspect this directory.`,
      );
    }
    if (result.status === 0 || result.stdout) {
      throw new Error(
        `Close the processes using ${directory}, then run again. Files are still open; not moving anything.`,
      );
    }
  }
}
