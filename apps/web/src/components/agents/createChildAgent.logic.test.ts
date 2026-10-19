import {
  CommandId,
  MessageId,
  NodeId,
  RunId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { createdManualChild, manualChildAgentCommand } from "./createChildAgent.logic";

function parent(status: OrchestrationV2Run["status"] = "completed") {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, branch: "vc/parent", worktreePath: "/own-parent" },
    runs: [
      {
        id: RunId.make("run:parent"),
        threadId: projection.thread.id,
        ordinal: 1,
        providerInstanceId: projection.thread.providerInstanceId,
        modelSelection: projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:parent"),
        rootNodeId: NodeId.make("node:parent"),
        activeAttemptId: null,
        status,
        requestedAt: projection.thread.createdAt,
        startedAt: projection.thread.createdAt,
        completedAt: projection.thread.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      } satisfies OrchestrationV2Run,
    ],
  };
}
const command = (
  projection: Parameters<typeof manualChildAgentCommand>[0]["parent"] = parent(),
  canOperate = true,
) =>
  manualChildAgentCommand({
    parent: projection,
    canOperate,
    commandId: CommandId.make("manual-request"),
    task: "  Inspect the changes  ",
    title: "  Inspector  ",
  });

describe("manual child delegation", () => {
  it("requests a native user-owned child worktree using its own parent pane and current model", () => {
    const projection = parent();
    expect(command(projection)).toMatchObject({
      type: "delegated_task.request",
      viewcodeUserRequested: true,
      createdBy: "user",
      creationSource: "web",
      parentThreadId: projection.thread.id,
      parentRunId: projection.runs[0]!.id,
      parentNodeId: projection.runs[0]!.rootNodeId,
      task: "Inspect the changes",
      title: "Inspector",
      modelSelection: projection.thread.modelSelection,
      workspaceStrategy: { type: "worktree", baseRef: "vc/parent", startFromOrigin: false },
      completionWake: "settled_only",
    });
  });
  it("rechecks operate permission rather than trusting the earlier menu's permission", () => {
    expect(() => command(parent(), false)).toThrow("cannot create agents");
  });
  it("requires a real active or completed parent run and a nonempty task", () => {
    expect(() => command(parent("failed"))).toThrow("Send one message");
    const empty = parent();
    empty.runs = [];
    expect(() => command(empty)).toThrow("Send one message");
    expect(() =>
      manualChildAgentCommand({
        parent: parent(),
        canOperate: true,
        commandId: CommandId.make("empty"),
        task: "  ",
        title: "",
      }),
    ).toThrow("Describe");
  });
  it("prefers the active run over previous completed runs", () => {
    const projection = parent("running");
    projection.runs.push({
      ...projection.runs[0]!,
      id: RunId.make("old-completed"),
      ordinal: 99,
      status: "completed",
    });
    expect(command(projection).parentRunId).toBe("run:parent");
  });
  it("does not silently use the main checkout HEAD for a detached parent worktree", () => {
    const projection = parent();
    expect(() =>
      command({ ...projection, thread: { ...projection.thread, branch: null } }),
    ).toThrow("Check out a branch");
  });
  it("does not navigate to a concurrent identical task or an existing child", () => {
    const before = parent();
    const input = command(before);
    const task = {
      id: NodeId.make("child-task"),
      createdBy: "user",
      prompt: input.task,
      title: input.title,
      runId: input.parentRunId,
      childThreadId: before.thread.id,
    } as OrchestrationV2Subagent;
    expect(createdManualChild(before, { subagents: [task] }, input)).toBe(before.thread.id);
    expect(createdManualChild({ subagents: [task] }, { subagents: [task] }, input)).toBeNull();
    expect(
      createdManualChild(
        before,
        { subagents: [task, { ...task, id: NodeId.make("concurrent") }] },
        input,
      ),
    ).toBeNull();
  });
});

it.each(["stopped", "disposed"] as const)(
  "requires a fresh user turn after a %s report cohort instead of reviving it",
  (disposition) => {
    const projection = parent();
    const closed = {
      ...projection,
      runs: projection.runs.map((run) => ({
        ...run,
        delegatedCompletion: { disposition, nextGeneration: 3, delivery: null },
      })),
    };
    expect(() => command(closed)).toThrow("Send another message");
    expect(closed.runs[0]!.delegatedCompletion.disposition).toBe(disposition);
  },
);
