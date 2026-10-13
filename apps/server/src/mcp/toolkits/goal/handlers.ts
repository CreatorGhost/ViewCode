import type { ThreadGoal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadGoals from "../../../orchestration/ThreadGoals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GoalToolkit } from "./tools.ts";

const toResult = (goal: ThreadGoal | null) => ({
  goal: goal === null ? null : { objective: goal.objective, paused: goal.pausedAt !== null },
});

const make = Effect.gen(function* () {
  const goals = yield* ThreadGoals.ThreadGoals;
  // The caller's own thread only: every session that has agent tools may read and set its goal.
  const caller = McpInvocationContext.requireMcpCapability("agents").pipe(
    Effect.map((scope) => scope.threadId),
  );
  return GoalToolkit.of({
    viewcode_get_goal: () => caller.pipe(Effect.flatMap(goals.get), Effect.map(toResult)),
    viewcode_set_goal: (input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          goals.set(threadId, {
            ...(input.objective !== undefined ? { objective: input.objective } : {}),
            ...(input.paused !== undefined ? { paused: input.paused } : {}),
          }),
        ),
        Effect.map(toResult),
      ),
  });
});

export const GoalToolkitHandlersLive = GoalToolkit.toLayer(make);
