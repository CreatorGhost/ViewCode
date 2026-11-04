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

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Where Claude Code reads an enterprise-managed MCP configuration. */
function claudeManagedMcpConfigPaths(platform: NodeJS.Platform): ReadonlyArray<string> {
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
  const paths = override ?? claudeManagedMcpConfigPaths(yield* HostProcess.Platform);
  return paths.some((filePath) => {
    try {
      return NodeFS.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
});

/** Where Claude Code reads the administrator's managed settings. */
function claudeManagedSettingsPaths(platform: NodeJS.Platform): ReadonlyArray<string> {
  switch (platform) {
    case "darwin":
      return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
    case "win32":
      return [
        "C:\\Program Files\\ClaudeCode\\managed-settings.json",
        "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
      ];
    default:
      return ["/etc/claude-code/managed-settings.json"];
  }
}

/** Override for the managed settings locations (tests); `undefined` uses the platform's. */
export const ClaudeManagedSettingsPaths = Context.Reference<ReadonlyArray<string> | undefined>(
  "server/provider/Drivers/ClaudeManagedSettingsPaths",
  { defaultValue: () => undefined },
);

/**
 * Whether the administrator's managed settings set
 * `disableBypassPermissionsMode: "disable"` (under `permissions`, or at the top
 * level as some MDM profiles write it). Claude Code then refuses the
 * `bypassPermissions` mode ViewCode uses for Full access, and the turn that
 * asked for it fails. An unreadable or malformed file counts as not set.
 */
const decodeManagedSettings = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

export const isClaudeBypassPermissionsDisabled: Effect.Effect<boolean> = Effect.gen(function* () {
  const override = yield* ClaudeManagedSettingsPaths;
  const paths = override ?? claudeManagedSettingsPaths(yield* HostProcess.Platform);
  return paths.some((filePath) => {
    try {
      const settings: unknown = decodeManagedSettings(NodeFS.readFileSync(filePath, "utf8"));
      if (typeof settings !== "object" || settings === null) return false;
      const record = settings as Record<string, unknown>;
      const permissions = record.permissions;
      const value =
        typeof permissions === "object" && permissions !== null
          ? ((permissions as Record<string, unknown>).disableBypassPermissionsMode ??
            record.disableBypassPermissionsMode)
          : record.disableBypassPermissionsMode;
      return value === "disable";
    } catch {
      return false;
    }
  });
});

/** Shown where Full access would be offered for Claude while the policy forbids it. */
export const CLAUDE_FULL_ACCESS_DISABLED_REASON =
  "Your organization's Claude Code policy turns off bypass permissions, so Full access runs as Auto-accept edits for Claude.";
