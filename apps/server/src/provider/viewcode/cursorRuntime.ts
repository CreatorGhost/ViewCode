/**
 * Which runtime a Cursor instance uses when its settings leave `runtime` unset.
 *
 * - `cursor-agent`: Cursor's own signed CLI as a subprocess over ACP. Its tools
 *   (`rg`, `cursorsandbox`) are children of `cursor-agent`, not of ViewCode.
 * - `sdk`: `@cursor/sdk` inside the server process, which then spawns those
 *   tools itself. Endpoint security on managed Macs kills the server for that.
 *
 * macOS prefers `cursor-agent` when the executable is found, then the SDK.
 * Elsewhere the SDK stays the default (what v2 has always run), and
 * `cursor-agent` is only the fallback for platforms the SDK does not ship.
 * Finding the executable is a filesystem lookup; it never runs it.
 *
 * @module CursorRuntime
 */
import type { CursorRuntime, CursorSettings } from "@t3tools/provider-cursor/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";

const CURSOR_AGENT_COMMAND = "cursor-agent";

/** Platforms `@cursor/sdk` publishes a native package for (its optionalDependencies). */
const CURSOR_SDK_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

function cursorSdkSupported(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  return CURSOR_SDK_PLATFORMS.has(`${platform}-${arch}`);
}

export function cursorAgentCommand(settings: Pick<CursorSettings, "binaryPath">): string {
  return settings.binaryPath?.trim() || CURSOR_AGENT_COMMAND;
}

export function resolveCursorRuntime(input: {
  readonly configured: CursorRuntime | undefined;
  readonly platform: NodeJS.Platform;
  readonly sdkSupported: boolean;
  readonly cursorAgentFound: boolean;
}): CursorRuntime {
  if (input.configured !== undefined) return input.configured;
  if (input.platform === "darwin" && input.cursorAgentFound) return "cursor-agent";
  return input.sdkSupported ? "sdk" : "cursor-agent";
}

/** The `cursor-agent` this instance would run, or `undefined` when it is not installed. */
export const findCursorAgentExecutable = Effect.fn("ViewCode.findCursorAgentExecutable")(function* (
  settings: Pick<CursorSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const resolve = yield* SpawnExecutableResolution;
  return resolve(expandHomePath(cursorAgentCommand(settings), home), platform, environment);
});

/** The runtime this instance uses; the PATH lookup only happens when it decides the default. */
export const effectiveCursorRuntime = Effect.fn("ViewCode.effectiveCursorRuntime")(function* (
  settings: Pick<CursorSettings, "runtime" | "binaryPath">,
  environment: NodeJS.ProcessEnv,
) {
  if (settings.runtime !== undefined) return settings.runtime;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  return resolveCursorRuntime({
    configured: undefined,
    platform,
    sdkSupported: cursorSdkSupported(platform, arch),
    cursorAgentFound:
      platform === "darwin" &&
      (yield* findCursorAgentExecutable(settings, environment)) !== undefined,
  });
});
