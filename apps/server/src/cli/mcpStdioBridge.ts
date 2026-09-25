import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { runMcpStdioBridgeMain } from "../mcp/McpStdioBridge.ts";

/**
 * Hosts the MCP stdio bridge inside the CLI executable, which has no Node to
 * run the sibling `mcp-stdio-bridge.mjs` script with.
 */
export const mcpStdioBridgeCommand = Command.make("__mcp-stdio-bridge", {
  socket: Flag.String("socket"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ socket }) =>
    Effect.promise(() => runMcpStdioBridgeMain(["--socket", socket])).pipe(
      Effect.flatMap((code) =>
        code === 0 ? Effect.void : Effect.sync(() => void (process.exitCode = code)),
      ),
    ),
  ),
);
