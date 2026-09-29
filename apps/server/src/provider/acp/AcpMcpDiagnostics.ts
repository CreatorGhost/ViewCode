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
