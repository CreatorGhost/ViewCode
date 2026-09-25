// Standalone entry for npm-distributed runtimes and the desktop app:
// `node mcp-stdio-bridge.mjs --socket <path>`. The executable reaches the same
// bridge through the `__mcp-stdio-bridge` subcommand.
import { runMcpStdioBridgeMain } from "./mcp/McpStdioBridge.ts";

process.exitCode = await runMcpStdioBridgeMain(process.argv.slice(2));
