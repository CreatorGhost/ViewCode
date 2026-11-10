// @effect-diagnostics nodeBuiltinImport:off - looks for the helper binary on disk when a worker starts.
/**
 * `ComputerDriver` backed by `native/computer-driver`, a ViewCode helper built
 * on agent-desktop's accessibility code (Apache-2.0, pinned in its
 * `Cargo.toml`). It reuses the xa11y driver's worker client unchanged, over
 * JSON lines instead of Node IPC, so queueing, timeouts, restarts, reply
 * decoding and the dispatch check are the same code for both drivers.
 *
 * Opt-in and observe-only for now: `VIEWCODE_COMPUTER_DRIVER=agent-desktop`
 * selects it, and the helper answers every input op with `unavailable` before
 * touching the desktop. The macOS desktop app ships the helper; a source
 * checkout builds it with `vp run build:computer-driver`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ComputerDriver } from "./ComputerDriver.ts";
import * as Xa11y from "./Xa11yComputerDriver.ts";

/** Which driver backs computer use; anything but `agent-desktop` keeps the default. */
const DRIVER_ENV = "VIEWCODE_COMPUTER_DRIVER";
/** An explicit helper path, for a helper built somewhere else. */
const BINARY_ENV = "VIEWCODE_COMPUTER_DRIVER_BINARY";

export const agentDesktopSelected = (value: string): boolean =>
  value.trim().toLowerCase() === "agent-desktop";

/**
 * Where the helper may be, most specific first. A path that was given is the
 * only candidate. The desktop app ships the helper beside the resource
 * monitor (`scripts/lib/viewcode-computer-driver.ts`), whose path the app
 * already hands the server; `moduleDir` covers a helper beside the server and
 * a source checkout, seen from the TypeScript source or from `dist`.
 */
export const agentDesktopBinaryCandidates = (input: {
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
export const agentDesktopBinary = (
  candidates: ReadonlyArray<string>,
  exists: (path: string) => boolean,
): string => candidates.find(exists) ?? candidates[0]!;

const layerAgentDesktop = Layer.effect(
  ComputerDriver,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const config = yield* ServerConfig.ServerConfig;
    const override = yield* Config.String(BINARY_ENV).pipe(Config.withDefault(""), Effect.orDie);
    const candidates = agentDesktopBinaryCandidates({
      platform,
      override,
      resourceMonitorPath: config.resourceMonitorPath,
      moduleDir: import.meta.dirname,
    });
    return yield* Xa11y.makeXa11yComputerDriver({
      platform,
      launch: () => ({
        command: agentDesktopBinary(candidates, NodeFS.existsSync),
        args: [],
        // The helper is spawned by the server, so macOS attributes it to the
        // app and it uses the app's Accessibility grant.
        env: { ...process.env },
        host: "native",
        transport: "stdio",
      }),
    });
  }),
);

/** The default xa11y driver, or the agent-desktop helper when asked for. */
export const layer: Layer.Layer<ComputerDriver, never, ServerConfig.ServerConfig> = Layer.unwrap(
  Config.String(DRIVER_ENV).pipe(
    Config.withDefault(""),
    Effect.orDie,
    Effect.map((value) => (agentDesktopSelected(value) ? layerAgentDesktop : Xa11y.layer)),
  ),
);
