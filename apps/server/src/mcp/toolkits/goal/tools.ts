import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadGoalObjective,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadGoals from "../../../orchestration-v2/ViewCodeGoals.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const GoalToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadGoals.ThreadGoalThreadNotFoundError,
  ThreadGoals.ThreadGoalMissingError,
  ThreadGoals.ThreadGoalInvalidObjectiveError,
  ThreadGoals.ThreadGoalStoreError,
]);

const GoalResult = Schema.Struct({
  goal: Schema.NullOr(
    Schema.Struct({
      objective: Schema.String,
      paused: Schema.Boolean.annotate({
        description: "A paused goal stays on the thread but is not sent with turns.",
      }),
    }),
  ),
});

/**
 * Synara's guardrail: a goal is the user's, so the model sets or changes one only when the user
 * states it. Kept as one exported string so a test pins it.
 */
export const SET_GOAL_TOOL_DESCRIPTION =
  "Set, change, pause, resume or clear this thread's persistent goal, which ViewCode gives you with every turn while it is active. Only set or change a goal when the user has explicitly stated one in this conversation (for example 'keep working until X' or 'the goal of this thread is Y'), in their words. Never infer, invent or reword a goal from an ordinary task, and never set one as a side effect of other work. Pausing, resuming or clearing also needs the user's explicit request; when you believe the goal is met, say so instead of clearing it.";

const GetGoalTool = Tool.make("viewcode_get_goal", {
  description:
    "Read this thread's goal: the objective the user set for it and whether it is paused. goal is null when none is set.",
  success: GoalResult,
  failure: GoalToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadGoals.ViewCodeGoals,
    ThreadManagement.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Read thread goal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SetGoalTool = Tool.make("viewcode_set_goal", {
  description: SET_GOAL_TOOL_DESCRIPTION,
  parameters: Schema.Struct({
    objective: Schema.optional(
      Schema.NullOr(ThreadGoalObjective).annotate({
        description:
          "The goal in the user's words. null clears the goal. Omit to only pause or resume.",
      }),
    ),
    paused: Schema.optional(
      Schema.Boolean.annotate({ description: "true pauses the goal, false resumes it." }),
    ),
  }),
  success: GoalResult,
  failure: GoalToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadGoals.ViewCodeGoals,
    ThreadManagement.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Set thread goal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetDebugTool = Tool.make("viewcode_get_debug_mode", {
  description: "Read whether this thread's ViewCode debug mode is enabled.",
  success: Schema.Struct({ enabled: Schema.Boolean }),
  failure: GoalToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadGoals.ViewCodeGoals,
    ThreadManagement.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const SetDebugTool = Tool.make("viewcode_set_debug_mode", {
  description:
    "Enable or disable this thread's ViewCode debug mode only when the user explicitly requests it. Debug mode asks every provider to reproduce, gather evidence and test causes before changing code. It grants no extra access.",
  parameters: Schema.Struct({ enabled: Schema.Boolean }),
  success: Schema.Struct({ enabled: Schema.Boolean }),
  failure: GoalToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadGoals.ViewCodeGoals,
    ThreadManagement.ThreadManagementService,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const GoalToolkit = Toolkit.make(GetGoalTool, SetGoalTool, GetDebugTool, SetDebugTool);
