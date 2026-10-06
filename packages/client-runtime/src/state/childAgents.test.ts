import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectAgentTree,
  collectChildAgents,
  countRunningChildAgents,
  isChildAgentRunning,
  resolveAgentControlAvailability,
  formatAgentElapsed,
  resolveChildAgentStatus,
  resolveSpawnedAgentRowStatus,
  spawnedAgentElapsedRange,
  spawnedAgentTaskTitle,
  summarizeAgentTreeControl,
} from "./childAgents.ts";

const env = EnvironmentId.make("env-a");
const otherEnv = EnvironmentId.make("env-b");

function shell(
  id: string,
  parent: string | null,
  overrides: Partial<{
    environmentId: EnvironmentId;
    archivedAt: string | null;
    sessionStatus: "running" | "starting" | "ready" | null;
    turnState: "running" | "completed" | null;
  }> = {},
) {
  const sessionStatus = overrides.sessionStatus ?? null;
  const turnState = overrides.turnState ?? null;
  return {
    id: ThreadId.make(id),
    environmentId: overrides.environmentId ?? env,
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    archivedAt: overrides.archivedAt ?? null,
    session:
      sessionStatus === null
        ? null
        : {
            threadId: ThreadId.make(id),
            status: sessionStatus,
            providerName: null,
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
    latestTurn:
      turnState === null
        ? null
        : {
            turnId: TurnId.make(`turn-${id}`),
            state: turnState,
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
  };
}

const root = { environmentId: env, threadId: ThreadId.make("root") };

describe("collectChildAgents", () => {
  it("returns nothing when the thread has no children", () => {
    expect(collectChildAgents([shell("root", null), shell("other", null)], root)).toEqual([]);
  });

  it("collects descendants depth-first with depth", () => {
    const agents = collectChildAgents(
      [
        shell("root", null),
        shell("a", "root"),
        shell("b", "root"),
        shell("a1", "a"),
        shell("a1x", "a1"),
        shell("unrelated", "someone-else"),
      ],
      root,
    );
    expect(agents.map((agent) => [agent.thread.id, agent.depth])).toEqual([
      ["a", 1],
      ["a1", 2],
      ["a1x", 3],
      ["b", 1],
    ]);
  });

  it("ignores other environments and archived threads (and their subtrees)", () => {
    const agents = collectChildAgents(
      [
        shell("a", "root", { environmentId: otherEnv }),
        shell("b", "root", { archivedAt: "2026-01-01T00:00:00.000Z" }),
        shell("b1", "b"),
        shell("c", "root"),
      ],
      root,
    );
    expect(agents.map((agent) => agent.thread.id)).toEqual(["c"]);
  });

  it("survives parent cycles", () => {
    const agents = collectChildAgents(
      [shell("a", "root"), shell("b", "a"), shell("root", "b")],
      root,
    );
    expect(agents.map((agent) => agent.thread.id)).toEqual(["a", "b"]);
  });

  it("scopes to a child's own subtree when rooted at the child", () => {
    const agents = collectChildAgents([shell("a", "root"), shell("a1", "a"), shell("b", "root")], {
      environmentId: env,
      threadId: ThreadId.make("a"),
    });
    expect(agents.map((agent) => agent.thread.id)).toEqual(["a1"]);
  });
});

describe("resolveChildAgentStatus", () => {
  const base = { hasPendingApprovals: false, hasPendingUserInput: false };
  it("ranks asks above working", () => {
    const running = shell("x", "root", { sessionStatus: "running" });
    expect(resolveChildAgentStatus({ ...running, ...base, hasPendingApprovals: true })).toBe(
      "approval",
    );
    expect(resolveChildAgentStatus({ ...running, ...base, hasPendingUserInput: true })).toBe(
      "input",
    );
    expect(resolveChildAgentStatus({ ...running, ...base })).toBe("working");
    expect(resolveChildAgentStatus({ ...shell("x", "root"), ...base })).toBe("idle");
  });
});

describe("running state", () => {
  it("treats starting/running sessions and running turns as running", () => {
    expect(isChildAgentRunning(shell("x", "root", { sessionStatus: "running" }))).toBe(true);
    expect(isChildAgentRunning(shell("x", "root", { sessionStatus: "starting" }))).toBe(true);
    expect(isChildAgentRunning(shell("x", "root", { turnState: "running" }))).toBe(true);
    expect(isChildAgentRunning(shell("x", "root", { sessionStatus: "ready" }))).toBe(false);
    expect(
      isChildAgentRunning(shell("x", "root", { sessionStatus: "ready", turnState: "completed" })),
    ).toBe(false);
  });

  it("counts running descendants", () => {
    const agents = collectChildAgents(
      [
        shell("a", "root", { sessionStatus: "running" }),
        shell("a1", "a", { turnState: "running" }),
        shell("b", "root", { sessionStatus: "ready" }),
      ],
      root,
    );
    expect(countRunningChildAgents(agents)).toBe(2);
  });
});

describe("collectAgentTree", () => {
  it("returns the root and all its descendants from any member", () => {
    const threads = [
      shell("lead", null),
      shell("a", "lead", { sessionStatus: "running" }),
      shell("a1", "a"),
      shell("b", "lead"),
      shell("other", null),
    ];
    const fromLeaf = collectAgentTree(threads, {
      environmentId: env,
      threadId: ThreadId.make("a1"),
    });
    expect(fromLeaf.map((entry) => [entry.thread.id, entry.depth, entry.running])).toEqual([
      ["lead", 0, false],
      ["a", 1, true],
      ["a1", 2, false],
      ["b", 1, false],
    ]);
    expect(
      collectAgentTree(threads, { environmentId: env, threadId: ThreadId.make("other") }).map(
        (entry) => entry.thread.id,
      ),
    ).toEqual(["other"]);
  });
});

describe("resolveAgentControlAvailability", () => {
  it("offers Stop only while a free agent runs", () => {
    expect(resolveAgentControlAvailability({ running: true, control: undefined })).toEqual({
      stop: true,
      resume: false,
      discard: false,
    });
    expect(resolveAgentControlAvailability({ running: false, control: undefined })).toEqual({
      stop: false,
      resume: false,
      discard: false,
    });
  });

  it("gives a stopped agent a way back: Resume, and Discard for held work", () => {
    expect(
      resolveAgentControlAvailability({ running: false, control: { paused: true, queued: 0 } }),
    ).toEqual({ stop: false, resume: true, discard: true });
    // Paused while the interrupt is still landing: no second Stop.
    expect(
      resolveAgentControlAvailability({ running: true, control: { paused: true, queued: 2 } }),
    ).toEqual({ stop: false, resume: true, discard: true });
  });

  it("offers Discard for messages queued behind a busy agent", () => {
    expect(
      resolveAgentControlAvailability({ running: true, control: { paused: false, queued: 1 } }),
    ).toEqual({ stop: true, resume: false, discard: true });
  });
});

describe("summarizeAgentTreeControl", () => {
  it("counts running, paused and queued agents across the tree", () => {
    const agents = collectAgentTree(
      [
        shell("lead", null, { sessionStatus: "running" }),
        shell("a", "lead", { turnState: "running" }),
        shell("b", "lead"),
        shell("c", "lead"),
      ],
      { environmentId: env, threadId: ThreadId.make("lead") },
    );
    const control = new Map([
      ["b", { paused: true, queued: 2 }],
      ["c", { paused: false, queued: 1 }],
    ]);
    expect(
      summarizeAgentTreeControl(
        agents.map((agent) => ({ running: agent.running, key: agent.thread.id })),
        control,
      ),
    ).toEqual({
      running: 2,
      paused: 1,
      queued: 3,
    });
  });
});

describe("spawned agent rows", () => {
  const turn = (state: "running" | "completed" | "interrupted" | "error") => ({
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: "2026-10-06T10:00:00.000Z",
    startedAt: "2026-10-06T10:00:01.000Z",
    completedAt: state === "running" ? null : "2026-10-06T10:02:15.000Z",
    assistantMessageId: null,
  });
  const child = (
    overrides: Partial<{
      latestTurn: ReturnType<typeof turn>;
      hasPendingApprovals: boolean;
    }>,
  ) => ({
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  });

  it("reads a running, finished, stopped and failed child", () => {
    expect(resolveSpawnedAgentRowStatus(child({ latestTurn: turn("running") }), "started")).toBe(
      "running",
    );
    expect(resolveSpawnedAgentRowStatus(child({ latestTurn: turn("completed") }), "started")).toBe(
      "done",
    );
    expect(
      resolveSpawnedAgentRowStatus(child({ latestTurn: turn("interrupted") }), "started"),
    ).toBe("stopped");
    expect(resolveSpawnedAgentRowStatus(child({ latestTurn: turn("error") }), "started")).toBe(
      "failed",
    );
  });

  it("puts a pending approval ahead of running", () => {
    expect(
      resolveSpawnedAgentRowStatus(
        child({ latestTurn: turn("running"), hasPendingApprovals: true }),
        "started",
      ),
    ).toBe("approval");
  });

  it("says queued before the first turn of a queued spawn", () => {
    expect(resolveSpawnedAgentRowStatus(child({}), "queued")).toBe("queued");
    expect(resolveSpawnedAgentRowStatus(null, "started")).toBeNull();
  });

  it("measures the latest turn, open-ended while it runs", () => {
    expect(spawnedAgentElapsedRange({ latestTurn: turn("running") })).toEqual({
      startMs: Date.parse("2026-10-06T10:00:01.000Z"),
      endMs: null,
    });
    const done = spawnedAgentElapsedRange({ latestTurn: turn("completed") });
    expect(done && done.endMs !== null ? formatAgentElapsed(done.endMs - done.startMs) : "").toBe(
      "2m 14s",
    );
    expect(spawnedAgentElapsedRange({ latestTurn: null })).toBeNull();
  });

  it("formats elapsed time in whole units", () => {
    expect(formatAgentElapsed(7_400)).toBe("7s");
    expect(formatAgentElapsed(60_000)).toBe("1m");
    expect(formatAgentElapsed(3_900_000)).toBe("1h 5m");
  });

  it("titles a spawn by its task, else its prompt's first line", () => {
    expect(spawnedAgentTaskTitle({ task: "diff panel design", body: "long prompt" })).toBe(
      "diff panel design",
    );
    expect(spawnedAgentTaskTitle({ body: "\n## Review the diff panel\nMore detail" })).toBe(
      "Review the diff panel",
    );
  });
});
