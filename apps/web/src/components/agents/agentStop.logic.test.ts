import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentStopState } from "./agentStop.logic";

const env = EnvironmentId.make("env");
const otherEnv = EnvironmentId.make("other-env");
const ref = (id: string, environmentId = env) => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const shell = (
  id: string,
  parent: string | null,
  options: {
    running?: boolean;
    archived?: boolean;
    environmentId?: EnvironmentId;
    kind?: "sidechat";
  } = {},
) => ({
  environmentId: options.environmentId ?? env,
  id: ThreadId.make(id),
  parentThreadId: parent === null ? null : ThreadId.make(parent),
  archivedAt: options.archived ? "2026-10-18T00:00:00.000Z" : null,
  kind: options.kind ?? null,
  session: options.running
    ? {
        threadId: ThreadId.make(id),
        status: "running" as const,
        providerName: null,
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-10-18T00:00:00.000Z",
      }
    : null,
  latestTurn: null,
});

const trees = [
  shell("left", null, { running: true }),
  shell("left-child", "left", { running: true }),
  shell("right", null, { running: true }),
  shell("right-child", "right", { running: true }),
  shell("right-grandchild", "right-child", { running: true }),
  shell("idle", "right"),
  shell("archived", "right", { running: true, archived: true }),
  shell("question", "right", { running: true, kind: "sidechat" }),
  shell("question-child", "question", { running: true }),
  shell("cross-environment", "right", { running: true, environmentId: otherEnv }),
];

describe("agent stop scope", () => {
  it("uses the background pane's explicit thread instead of the focused route tree", () => {
    const state = agentStopState(trees, ref("right"), ref("left"));
    expect(state.ref).toEqual(ref("right"));
    expect(state.othersRunning.map(({ thread }) => thread.id)).toEqual([
      "right-child",
      "right-grandchild",
    ]);
  });

  it("offers the whole matching tree when invoked from a child", () => {
    const state = agentStopState(trees, ref("right-child"), ref("left"));
    expect(state.othersRunning.map(({ thread }) => thread.id)).toEqual([
      "right",
      "right-grandchild",
    ]);
  });

  it("keeps explicit draft panes outside the focused route's stop menu", () => {
    expect(agentStopState(trees, null, ref("left"))).toEqual({ ref: null, othersRunning: [] });
  });

  it("stops a side chat directly without offering its parent's agent tree", () => {
    const state = agentStopState(trees, ref("question"), ref("left"));
    expect(state.ref).toEqual(ref("question"));
    expect(state.othersRunning).toEqual([]);
  });

  it("falls back to route scope only for callers that omit the pane reference", () => {
    const state = agentStopState(trees, undefined, ref("left"));
    expect(state.ref).toEqual(ref("left"));
    expect(state.othersRunning.map(({ thread }) => thread.id)).toEqual(["left-child"]);
  });

  it("does not offer another tree when its own shell is not available", () => {
    expect(agentStopState(trees, ref("missing"), ref("left")).othersRunning).toEqual([]);
  });
});
