/**
 * ViewCode's Pi extension, loaded with `pi -e <file>`. It adds ViewCode's MCP
 * server to the session (`pi.registerMcpServer`, Pi 0.99+) and, outside Full
 * access, asks before tools that change anything: the confirm reaches ViewCode
 * as an `extension_ui_request` the adapter turns into an approval.
 *
 * Pi has no permission system of its own, so this hook is the only gate. The
 * extension reads its configuration from the environment, so one file serves
 * every session and credentials never touch disk.
 *
 * @module piExtension
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import { MCP_SERVER_NAME } from "../mcp/McpProviderSession.ts";

export const PI_MCP_SERVER_ENV = "VIEWCODE_PI_MCP_SERVER";
export const PI_RUNTIME_MODE_ENV = "VIEWCODE_PI_RUNTIME_MODE";

/** Tools the hook lets through without asking: reads, and ViewCode's own tools, which the server gates. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const FILE_CHANGE_TOOLS = ["edit", "write"];

export const PI_EXTENSION_SOURCE = `// Written by ViewCode; regenerated on every session start.
const READ_ONLY_TOOLS = new Set(${JSON.stringify(READ_ONLY_TOOLS)});
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(FILE_CHANGE_TOOLS)});

export default function viewcode(pi) {
  const server = process.env[${JSON.stringify(PI_MCP_SERVER_ENV)}];
  if (server) {
    try {
      pi.registerMcpServer(${JSON.stringify(MCP_SERVER_NAME)}, JSON.parse(server));
    } catch (error) {
      console.error("ViewCode tools unavailable: " + String(error));
    }
  }
  const mode = process.env[${JSON.stringify(PI_RUNTIME_MODE_ENV)}] ?? "full-access";
  if (mode === "full-access") return;
  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;
    if (READ_ONLY_TOOLS.has(name) || name.startsWith("mcp__${MCP_SERVER_NAME}__")) return;
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(name)) return;
    let input;
    try {
      input = JSON.stringify(event.input ?? {}, null, 2).slice(0, 4000);
    } catch {
      input = String(event.input);
    }
    const approved = await ctx.ui.confirm("Allow " + name + "?", input, { signal: ctx.signal });
    if (!approved) return { block: true, reason: name + " was declined in ViewCode." };
  });
}
`;

/** Pi's `registerMcpServer` config for ViewCode's MCP server: HTTP, or the stdio bridge on a socket listener. */
export function piMcpServerConfig(
  config: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader" | "stdio">,
) {
  return config.stdio
    ? { command: config.stdio.command, args: [...config.stdio.args], env: { ...config.stdio.env } }
    : { url: config.endpoint, headers: { Authorization: config.authorizationHeader } };
}

/** The tool name a hook confirm (`Allow <tool>?`) asks about. */
export function piConfirmToolName(title: string | undefined): string | undefined {
  return title?.match(/^Allow (\S+)\?$/)?.[1];
}

/**
 * Writes the extension under the state directory and returns its path. The
 * write is atomic because a Pi process of another thread may be loading it.
 */
export const ensurePiExtension = Effect.fn("ensurePiExtension")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, "pi", "viewcode-extension.mjs");
  const current = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (current !== PI_EXTENSION_SOURCE) {
    yield* writeFileStringAtomically({ filePath: file, contents: PI_EXTENSION_SOURCE });
  }
  return file;
});
