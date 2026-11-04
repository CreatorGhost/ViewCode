import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function manualChildAgentCommand(input: {
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">;
  commandId: CommandId;
  canOperate: boolean;
  task: string;
  title: string;
}): Extract<OrchestrationV2Command, { type: "delegated_task.request" }> {
  if (!input.canOperate) throw new Error("This connection cannot create agents.");
  const { thread, runs } = input.parent;
  if (thread.archivedAt !== null || thread.deletedAt !== null)
    throw new Error("Reopen this thread before creating an agent.");
  const task = input.task.trim();
  if (!task) throw new Error("Describe the child agent's task first.");
  if (thread.worktreePath !== null && thread.branch === null)
    throw new Error("Check out a branch in the parent workspace before creating an agent.");
  const eligible = runs.filter(
    (run) =>
      run.rootNodeId !== null &&
      ["preparing", "starting", "running", "waiting", "completed"].includes(run.status),
  );
  const active = eligible.filter((run) => run.status !== "completed");
  const run = (active.length ? active : eligible).toSorted(
    (left, right) => right.ordinal - left.ordinal,
  )[0];
  if (!run?.rootNodeId)
    throw new Error("Send one message in this thread before creating an agent.");
  if (run.delegatedCompletion !== undefined && run.delegatedCompletion.disposition !== "open")
    throw new Error(
      "Child-agent reporting for this turn was stopped or cancelled. Send another message in this thread before creating a new child agent.",
    );
  return {
    type: "delegated_task.request",
    viewcodeUserRequested: true,
    commandId: input.commandId,
    parentThreadId: thread.id,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId,
    task,
    title: input.title.trim() || "New agent",
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    workspaceStrategy: {
      type: "worktree",
      baseRef: thread.branch ?? "HEAD",
      startFromOrigin: false,
    },
    completionWake: "settled_only",
    createdBy: "user",
    creationSource: "web",
  };
}

/** A concurrent identical request must not navigate to someone else's child. */
export function createdManualChild(
  before: Pick<OrchestrationV2ThreadProjection, "subagents">,
  after: Pick<OrchestrationV2ThreadProjection, "subagents">,
  command: Extract<OrchestrationV2Command, { type: "delegated_task.request" }>,
) {
  const existing = new Set(before.subagents.map((task) => task.id));
  const matches = after.subagents.filter(
    (task) =>
      !existing.has(task.id) &&
      task.createdBy === "user" &&
      task.prompt === command.task &&
      task.title === command.title &&
      task.runId === command.parentRunId &&
      task.childThreadId !== null,
  );
  return matches.length === 1 ? matches[0]!.childThreadId : null;
}
