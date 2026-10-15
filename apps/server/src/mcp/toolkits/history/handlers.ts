import * as Effect from "effect/Effect";

import {
  importRecentAgentThreads,
  listImportableAgentSessions,
} from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HistoryToolkit } from "./tools.ts";

type ImporterServices =
  | Effect.Services<ReturnType<typeof importRecentAgentThreads>>
  | Effect.Services<ReturnType<typeof listImportableAgentSessions>>;

/** The same scan, list and import the `agentSessions.*` RPCs run, for any session with agent tools. */
const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const services = yield* Effect.context<ImporterServices>();
  const caller = McpInvocationContext.requireMcpCapability("agents");
  return HistoryToolkit.of({
    viewcode_scan_importable_projects: () => caller.pipe(Effect.andThen(scanner.scan)),
    viewcode_list_importable_sessions: (input) =>
      caller.pipe(Effect.andThen(listImportableAgentSessions(input)), Effect.provide(services)),
    viewcode_import_sessions: (input) =>
      caller.pipe(Effect.andThen(importRecentAgentThreads(input)), Effect.provide(services)),
  });
});

export const HistoryToolkitHandlersLive = HistoryToolkit.toLayer(make);
