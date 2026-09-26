import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AgentSessionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { importedThreadsForCleanup, partitionImportableSessions } from "./agentSessionImport.logic";

function session(
  providerSessionId: string,
  lastActivityAt: string,
  hiddenReason: AgentSessionSummary["hiddenReason"] = null,
): AgentSessionSummary {
  return {
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId,
    provider: "codex",
    title: providerSessionId,
    firstActivityAt: lastActivityAt,
    lastActivityAt,
    userMessageCount: 3,
    alreadyImported: false,
    hidden: hiddenReason !== null,
    hiddenReason,
  };
}

describe("partitionImportableSessions", () => {
  it("sorts newest first and folds hidden sessions away", () => {
    const older = session("older", "2026-08-01T00:00:00.000Z");
    const newer = session("newer", "2026-08-20T00:00:00.000Z");
    const child = session("child", "2026-08-21T00:00:00.000Z", "subagent");

    expect(partitionImportableSessions([older, child, newer])).toEqual({
      visible: [newer, older],
      hidden: [child],
    });
  });
});

describe("importedThreadsForCleanup", () => {
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("project-1");
  const thread = (
    id: string,
    overrides: Partial<Parameters<typeof importedThreadsForCleanup>[0][number]> = {},
  ) => ({
    id: ThreadId.make(id),
    environmentId,
    projectId,
    archivedAt: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    latestTurn: null,
    session: null,
    ...overrides,
  });

  it("offers only the project's active imported threads and marks continued ones", () => {
    const untouched = thread("import:codex:a");
    const continued = thread("import:codex:b", {
      createdAt: "2026-08-21T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-22T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const archived = thread("import:codex:c", { archivedAt: "2026-08-22T00:00:00.000Z" });
    const native = thread("native-thread");
    const otherProject = thread("import:codex:d", { projectId: ProjectId.make("project-2") });
    const otherEnvironment = thread("import:codex:e", {
      environmentId: EnvironmentId.make("remote"),
    });

    expect(
      importedThreadsForCleanup(
        [untouched, continued, archived, native, otherProject, otherEnvironment],
        [{ environmentId, projectId }],
      ),
    ).toEqual([
      { thread: continued, untouched: false },
      { thread: untouched, untouched: true },
    ]);
  });
});
