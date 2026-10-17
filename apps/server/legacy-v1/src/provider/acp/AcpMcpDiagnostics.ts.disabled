import type * as EffectAcpSchema from "effect-acp/schema";

/** Configuration handed to an agent, not evidence that it loaded any tools. */
export function summarizeMcpServers(servers: ReadonlyArray<EffectAcpSchema.McpServer>) {
  return {
    mcpServerCount: servers.length,
    mcpTransports: [
      ...new Set(servers.map((server) => ("type" in server ? server.type : "stdio"))),
    ],
    toolsAvailability: servers.length > 0 ? "unverified" : "not-configured",
  };
}

export function unsupportedMcpTransports(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  capabilities: EffectAcpSchema.McpCapabilities | null | undefined,
) {
  // ACP requires stdio support. Only HTTP and SSE need an advertised capability.
  return [
    ...new Set(
      servers.flatMap((server) =>
        "type" in server && capabilities?.[server.type] !== true ? [server.type] : [],
      ),
    ),
  ];
}

/** Splits configured servers into those the agent can take and the transports it cannot.
 * Absent and explicit `false` capabilities are treated alike. */
export function partitionMcpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  capabilities: EffectAcpSchema.McpCapabilities | null | undefined,
) {
  const unsupportedTransports = unsupportedMcpTransports(servers, capabilities);
  return {
    unsupportedTransports,
    supportedServers: servers.filter(
      (server) => !("type" in server && unsupportedTransports.includes(server.type)),
    ),
  };
}

/** Why ViewCode's own MCP server is missing from an ACP chat. */
export type ViewcodeToolsMissingReason =
  | { readonly kind: "not-issued" }
  | {
      readonly kind: "unsupported-transport";
      readonly unsupportedTransports: ReadonlyArray<string>;
    };

/** Payload of the `runtime.warning` a chat gets when it starts without ViewCode tools. */
export function viewcodeToolsUnavailableWarning(
  providerLabel: string,
  reason: ViewcodeToolsMissingReason,
) {
  return {
    message: `ViewCode tools aren't available in this chat (${providerLabel} didn't accept the tool connection). Child agents and agent messaging won't work here; you can still create child agents from the sidebar.`,
    detail:
      reason.kind === "not-issued"
        ? "ViewCode did not issue an MCP session for this chat."
        : `${providerLabel} does not advertise MCP transport: ${reason.unsupportedTransports.join(", ")}.`,
  };
}
