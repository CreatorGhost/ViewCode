import type { ThreadGoal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ViewCodeGoals from "../../../orchestration-v2/ViewCodeGoals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GoalToolkit } from "./tools.ts";

const toResult = (goal: ThreadGoal | null) => ({
  goal: goal === null ? null : { objective: goal.objective, paused: goal.pausedAt !== null },
});
const caller = McpInvocationContext.requireMcpCapability("orchestration").pipe(
  Effect.flatMap((scope) =>
    McpInvocationContext.requireThreadScope(scope, "ViewCode goals and debug mode"),
  ),
  Effect.map((scope) => scope.thread.threadId),
);
export const layer = McpToolAccess.toLayer(GoalToolkit, {
  viewcode_get_goal: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const goals = yield* ViewCodeGoals.ViewCodeGoals;
      return toResult(yield* goals.get(yield* caller));
    }),
  ),
  viewcode_set_goal: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const goals = yield* ViewCodeGoals.ViewCodeGoals;
      return toResult(yield* goals.set(yield* caller, input));
    }),
  ),
  viewcode_get_debug_mode: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const goals = yield* ViewCodeGoals.ViewCodeGoals;
      return { enabled: yield* goals.getDebug(yield* caller) };
    }),
  ),
  viewcode_set_debug_mode: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const goals = yield* ViewCodeGoals.ViewCodeGoals;
      return { enabled: yield* goals.setDebug(yield* caller, input.enabled) };
    }),
  ),
});
