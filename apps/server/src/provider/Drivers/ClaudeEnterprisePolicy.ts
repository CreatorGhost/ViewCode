// @effect-diagnostics nodeBuiltinImport:off
/**
 * ViewCode: Claude Code enterprise policy.
 *
 * On machines with an enterprise-managed MCP configuration, Claude Code
 * refuses `--strict-mcp-config`, so the capability probe and text generation
 * must not pass it there. They still pass an empty MCP server map and disable
 * claude.ai connectors, so nothing extra is loaded.
 *
 * @module provider/Drivers/ClaudeEnterprisePolicy
 */
import * as NodeFS from "node:fs";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Where Claude Code reads an enterprise-managed MCP configuration. */
export function claudeManagedMcpConfigPaths(platform: NodeJS.Platform): ReadonlyArray<string> {
  switch (platform) {
    case "darwin":
      return ["/Library/Application Support/ClaudeCode/managed-mcp.json"];
    case "win32":
      return ["C:\\Program Files\\ClaudeCode\\managed-mcp.json"];
    default:
      return ["/etc/claude-code/managed-mcp.json"];
  }
}

/** Override for the policy file locations (tests); `undefined` uses the platform's. */
export const ClaudeManagedMcpConfigPaths = Context.Reference<ReadonlyArray<string> | undefined>(
  "server/provider/Drivers/ClaudeManagedMcpConfigPaths",
  { defaultValue: () => undefined },
);

/** Whether an enterprise-managed MCP configuration is present on this machine. */
export const hasClaudeManagedMcpConfig: Effect.Effect<boolean> = Effect.gen(function* () {
  const override = yield* ClaudeManagedMcpConfigPaths;
  const paths = override ?? claudeManagedMcpConfigPaths(yield* HostProcessPlatform);
  return paths.some((filePath) => {
    try {
      return NodeFS.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
});
