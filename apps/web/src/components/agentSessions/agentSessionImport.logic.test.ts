import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { importedThreadsForCleanup } from "./agentSessionImport.logic";

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
