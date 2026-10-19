import * as Layer from "effect/Layer";

import * as AgentMessaging from "../agents/AgentMessagingV2.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
export { AgentsToolkit } from "../mcp/toolkits/agents/tools.ts";
export { layer as toolkitHandlers } from "../mcp/toolkits/agents/handlers.ts";

// Reuses the upstream delegation implementation and its worktree/receipt lifecycle.
// The server supplies native orchestration, provider/project services and ViewCode activity storage.
export const layer = AgentMessaging.layer.pipe(Layer.provide(OrchestratorMcpService.layer));
