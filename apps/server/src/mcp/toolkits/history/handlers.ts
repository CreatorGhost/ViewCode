import * as Effect from "effect/Effect";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HistoryToolkit } from "./tools.ts";

const caller = McpInvocationContext.requireMcpCapability("agents");

export const layer = McpToolAccess.toLayer(HistoryToolkit, {
  viewcode_scan_importable_projects: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* caller;
      return yield* (yield* AgentSessionScanner.AgentSessionScanner).scan;
    }),
  ),
  viewcode_list_importable_sessions: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* caller;
      return yield* (yield* AgentSessionImporter.AgentSessionImporter).listImportableAgentSessions(
        input,
      );
    }),
  ),
  viewcode_import_sessions: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* caller;
      return yield* (yield* AgentSessionImporter.AgentSessionImporter).importRecentAgentThreads(
        input,
      );
    }),
  ),
});
