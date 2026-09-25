import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import type { McpStdioLaunch } from "./McpProviderSession.ts";

/**
 * The command a provider runs to reach `/mcp` over `socketPath`. Uses the
 * server's own runtime: the npm bundle and the desktop app run the sibling
 * `mcp-stdio-bridge` script under this process's Node (Electron runs as Node
 * with `ELECTRON_RUN_AS_NODE`), and the single executable hosts the bridge as a
 * hidden subcommand of itself. The caller adds the credential to `env`.
 */
export const resolveMcpStdioBridgeLaunch = Effect.fn("McpStdioBridge.resolveLaunch")(function* (
  socketPath: string,
) {
  const socketArgs = ["--socket", socketPath];
  if (yield* HostProcessIsExecutable) {
    return {
      command: process.execPath,
      args: ["__mcp-stdio-bridge", ...socketArgs],
      env: {},
    } satisfies McpStdioLaunch;
  }
  const path = yield* Path.Path;
  const scriptPath = yield* path
    .fromFileUrl(
      new URL(
        import.meta.url.endsWith(".ts") ? "../mcp-stdio-bridge.ts" : "./mcp-stdio-bridge.mjs",
        import.meta.url,
      ),
    )
    .pipe(Effect.orDie);
  return {
    command: process.execPath,
    args: [scriptPath, ...socketArgs],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  } satisfies McpStdioLaunch;
});
