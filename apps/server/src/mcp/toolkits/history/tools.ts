import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionListInput,
  AgentSessionListResult,
  AgentSessionRef,
  AgentSessionScanError,
  AgentSessionScanResult,
  McpCapabilityUnavailableError,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const HistoryToolError = Schema.Union([
  McpCapabilityUnavailableError,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
]);

const ScanTool = Tool.make("viewcode_scan_importable_projects", {
  description:
    "List folders on this machine with past Claude Code, Codex, Cursor or T3 Code conversations that ViewCode can import, with how many and when last used. Use it only when the user asks to bring in past conversations.",
  success: AgentSessionScanResult,
  failure: HistoryToolError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Find importable projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListTool = Tool.make("viewcode_list_importable_sessions", {
  description:
    "List the past Claude Code, Codex, Cursor and T3 Code conversations of one ViewCode project that can be imported as threads. Sessions with hiddenReason set are agent plumbing or fragments; alreadyImported ones are threads already.",
  parameters: AgentSessionListInput,
  success: AgentSessionListResult,
  failure: HistoryToolError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "List importable sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ImportTool = Tool.make("viewcode_import_sessions", {
  description:
    "Import the named past conversations into a ViewCode project as threads, as Import past sessions in the sidebar does. Import only sessions the user chose; already imported ones are skipped.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    sessions: Schema.Array(AgentSessionRef).annotate({
      description: "providerInstanceId and providerSessionId of each session, from the list tool.",
    }),
  }),
  success: AgentSessionImportResult,
  failure: HistoryToolError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Import past sessions")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const HistoryToolkit = Toolkit.make(ScanTool, ListTool, ImportTool);
