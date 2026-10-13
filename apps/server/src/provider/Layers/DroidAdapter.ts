/**
 * DroidAdapter — Factory Droid (`droid exec --output-format acp`) through the
 * shared ACP agent adapter.
 *
 * @module DroidAdapter
 */
import { type DroidSettings, ProviderDriverKind } from "@t3tools/contracts";

import { acpStdioMcpServerConfig } from "../../mcp/McpProviderSession.ts";
import { configureDroidSession, makeDroidAcpRuntime } from "../acp/DroidAcpSupport.ts";
import { type AcpAgentAdapterOptions, makeAcpAgentAdapter } from "./AcpAgentAdapter.ts";

const PROVIDER = ProviderDriverKind.make("droid");

export function makeDroidAdapter(settings: DroidSettings, options: AcpAgentAdapterOptions) {
  return makeAcpAgentAdapter(
    {
      provider: PROVIDER,
      label: "Droid",
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      // Droid's autonomy is a session config option, applied per turn.
      makeRuntime: ({ loggers, runtimeMode: _runtimeMode, ...input }) =>
        makeDroidAcpRuntime({ ...input, ...loggers, settings, provider: PROVIDER }),
      configureSession: configureDroidSession,
      // Droid advertises no MCP transport, so it gets the stdio bridge.
      mcpServer: acpStdioMcpServerConfig,
    },
    options,
  );
}
