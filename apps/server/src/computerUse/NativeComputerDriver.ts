// @effect-diagnostics nodeBuiltinImport:off - looks for the helper binary on disk when a worker starts.
/**
 * The `ComputerDriver`: `native/computer-driver`, ViewCode's helper built on
 * agent-desktop's accessibility code (Apache-2.0, pinned in its `Cargo.toml`),
 * reached through `ComputerDriverClient`. The macOS desktop app ships the
 * helper; a source checkout builds it with `vp run build:computer-driver`.
 * When it is missing, computer use reports itself unavailable.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ComputerDriver } from "./ComputerDriver.ts";
import { makeComputerDriverClient } from "./ComputerDriverClient.ts";

/** An explicit helper path, for a helper built somewhere else. */
const BINARY_ENV = "VIEWCODE_COMPUTER_DRIVER_BINARY";

/**
 * Where the helper may be, most specific first. A path that was given is the
 * only candidate. The desktop app ships the helper beside the resource
 * monitor (`scripts/lib/viewcode-computer-driver.ts`), whose path the app
 * already hands the server; `moduleDir` covers a helper beside the server and
 * a source checkout, seen from the TypeScript source or from `dist`.
 */
export const computerDriverBinaryCandidates = (input: {
  readonly platform: NodeJS.Platform;
  readonly override: string;
  readonly resourceMonitorPath: string | undefined;
  readonly moduleDir: string;
}): ReadonlyArray<string> => {
  if (input.override.trim().length > 0) return [input.override.trim()];
  const name =
    input.platform === "win32" ? "viewcode-computer-driver.exe" : "viewcode-computer-driver";
  return [
    ...(input.resourceMonitorPath === undefined
      ? []
      : [NodePath.resolve(input.resourceMonitorPath, "../../computer-driver", name)]),
    NodePath.resolve(input.moduleDir, "computer-driver", name),
    NodePath.resolve(input.moduleDir, "../computer-driver", name),
    NodePath.resolve(input.moduleDir, "../../../../native/computer-driver/target/release", name),
    NodePath.resolve(input.moduleDir, "../../../native/computer-driver/target/release", name),
  ];
};

/** The first helper that exists; else the first place it was looked for, so the spawn fails there. */
export const computerDriverBinary = (
  candidates: ReadonlyArray<string>,
  exists: (path: string) => boolean,
): string => candidates.find(exists) ?? candidates[0]!;

export const layer = Layer.effect(
  ComputerDriver,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const config = yield* ServerConfig.ServerConfig;
    const override = yield* Config.String(BINARY_ENV).pipe(Config.withDefault(""), Effect.orDie);
    const candidates = computerDriverBinaryCandidates({
      platform,
      override,
      resourceMonitorPath: config.resourceMonitorPath,
      moduleDir: import.meta.dirname,
    });
    return yield* makeComputerDriverClient({
      platform,
      launch: () => ({
        command: computerDriverBinary(candidates, NodeFS.existsSync),
        args: [],
        env: { ...process.env },
      }),
    });
  }),
);
