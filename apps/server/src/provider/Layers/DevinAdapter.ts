/**
 * DevinAdapter — Devin CLI (`devin acp`) through the shared ACP agent adapter.
 *
 * @module DevinAdapter
 */
import { type DevinSettings, ProviderDriverKind } from "@t3tools/contracts";

import { acpStdioMcpServerConfig } from "../../mcp/McpProviderSession.ts";
import { configureDevinSession, makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";
import { type AcpAgentAdapterOptions, makeAcpAgentAdapter } from "./AcpAgentAdapter.ts";

const PROVIDER = ProviderDriverKind.make("devin");

export function makeDevinAdapter(settings: DevinSettings, options: AcpAgentAdapterOptions) {
  return makeAcpAgentAdapter(
    {
      provider: PROVIDER,
      label: "Devin",
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compact" },
      loadReplayQuiet: { quietMs: 200, maxMs: 1_500 },
      // Devin's mode is a session config option, applied per turn.
      makeRuntime: ({ loggers, runtimeMode: _runtimeMode, ...input }) =>
        makeDevinAcpRuntime({ ...input, ...loggers, settings, provider: PROVIDER }),
      configureSession: configureDevinSession,
      // Devin advertises `http: false`, so it gets the stdio bridge.
      mcpServer: acpStdioMcpServerConfig,
    },
    options,
  );
}
