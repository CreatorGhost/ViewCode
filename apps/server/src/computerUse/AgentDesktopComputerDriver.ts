// @effect-diagnostics nodeBuiltinImport:off - resolves the helper binary beside this module.
/**
 * `ComputerDriver` backed by `native/computer-driver`, a ViewCode helper built
 * on agent-desktop's accessibility code (Apache-2.0, pinned in its
 * `Cargo.toml`). It reuses the xa11y driver's worker client unchanged, over
 * JSON lines instead of Node IPC, so queueing, timeouts, restarts, reply
 * decoding and the dispatch check are the same code for both drivers.
 *
 * Opt-in and observe-only for now: `VIEWCODE_COMPUTER_DRIVER=agent-desktop`
 * selects it, and the helper answers every input op with `unavailable` before
 * touching the desktop. The helper is not packaged yet, so this is for a
 * source checkout that ran `vp run build:computer-driver`.
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ComputerDriver } from "./ComputerDriver.ts";
import * as Xa11y from "./Xa11yComputerDriver.ts";

/** Which driver backs computer use; anything but `agent-desktop` keeps the default. */
const DRIVER_ENV = "VIEWCODE_COMPUTER_DRIVER";
/** An explicit helper path, for a helper built somewhere else. */
const BINARY_ENV = "VIEWCODE_COMPUTER_DRIVER_BINARY";

export const agentDesktopSelected = (value: string): boolean =>
  value.trim().toLowerCase() === "agent-desktop";

/** The helper a source checkout builds, unless a path was given. */
export const agentDesktopBinary = (
  platform: NodeJS.Platform,
  override: string,
  moduleUrl: string,
): string =>
  override.trim().length > 0
    ? override.trim()
    : NodePath.resolve(
        NodePath.dirname(NodeURL.fileURLToPath(moduleUrl)),
        "../../../../native/computer-driver/target/release",
        platform === "win32" ? "viewcode-computer-driver.exe" : "viewcode-computer-driver",
      );

export const layerAgentDesktop: Layer.Layer<ComputerDriver> = Layer.effect(
  ComputerDriver,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const override = yield* Config.String(BINARY_ENV).pipe(Config.withDefault(""), Effect.orDie);
    return yield* Xa11y.makeXa11yComputerDriver({
      platform,
      launch: () => ({
        command: agentDesktopBinary(platform, override, import.meta.url),
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
export const layer: Layer.Layer<ComputerDriver> = Layer.unwrap(
  Config.String(DRIVER_ENV).pipe(
    Config.withDefault(""),
    Effect.orDie,
    Effect.map((value) => (agentDesktopSelected(value) ? layerAgentDesktop : Xa11y.layer)),
  ),
);
