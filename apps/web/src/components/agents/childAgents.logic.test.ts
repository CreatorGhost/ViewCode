import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectAgentTree,
  collectChildAgents,
  countRunningChildAgents,
  isChildAgentRunning,
  resolveChildAgentStatus,
} from "./childAgents.logic";

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
