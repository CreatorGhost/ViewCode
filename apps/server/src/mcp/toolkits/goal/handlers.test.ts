import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadGoal,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadGoals from "../../../orchestration/ThreadGoals.ts";
import { nextThreadGoal } from "../../../orchestration/threadGoal.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GoalToolkitHandlersLive } from "./handlers.ts";
import { GoalToolkit, SET_GOAL_TOOL_DESCRIPTION } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-goal-tool");
const NOW = "2026-01-01T00:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeGoalToolkitHarness")(function* () {
  const goal = yield* Ref.make<ThreadGoal | null>(null);
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  // The engine applies a meta update the way the decider does, so reads see it.
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.meta.update") {
        const next = nextThreadGoal(yield* Ref.get(goal), command, NOW);
        if (next !== undefined) yield* Ref.set(goal, next);
      }
      return { sequence: 1 };
    });
  const context = yield* Layer.build(
    ThreadGoals.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () =>
              Ref.get(goal).pipe(
                Effect.map((current) =>
                  Effect.succeedSome({ id: THREAD_ID, goal: current } as OrchestrationThreadShell),
                ),
                Effect.flatten,
              ),
          }),
          Layer.mock(OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch,
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
          Layer.succeed(Crypto.Crypto, testCrypto),
        ),
      ),
    ),
  );
  const toolkit = yield* GoalToolkit.pipe(
    Effect.provide(GoalToolkitHandlersLive),
    Effect.provideContext(context),
  );
  const call = <Name extends "viewcode_get_goal" | "viewcode_set_goal">(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["agents"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof GoalToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    );
  return { commands, call };
});

describe("goal toolkit", () => {
  it("tells the model never to invent a goal", () => {
    expect(SET_GOAL_TOOL_DESCRIPTION).toContain(
      "Only set or change a goal when the user has explicitly stated one",
    );
    expect(SET_GOAL_TOOL_DESCRIPTION).toContain("Never infer, invent or reword a goal");
    expect(SET_GOAL_TOOL_DESCRIPTION).toContain("never set one as a side effect");
  });

  it.effect("reads, sets, pauses and clears the caller's own thread goal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call("viewcode_get_goal", {})).toEqual({ goal: null });

      // Pausing a goal that does not exist is refused before anything is dispatched.
      const refused = yield* Effect.flip(harness.call("viewcode_set_goal", { paused: true }));
      expect(refused).toBeInstanceOf(ThreadGoals.ThreadGoalMissingError);
      expect(yield* Ref.get(harness.commands)).toEqual([]);

      expect(yield* harness.call("viewcode_set_goal", { objective: "CI is green" })).toEqual({
        goal: { objective: "CI is green", paused: false },
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.meta.update", threadId: THREAD_ID, goal: "CI is green" },
      ]);
      expect(yield* harness.call("viewcode_set_goal", { paused: true })).toEqual({
        goal: { objective: "CI is green", paused: true },
      });
      expect(yield* harness.call("viewcode_set_goal", { objective: null })).toEqual({
        goal: null,
      });
    }),
  );

  it.effect("needs the agents capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* Effect.flip(harness.call("viewcode_get_goal", {}, ["html"]));
      expect(error._tag).toBe("McpCapabilityUnavailableError");
    }),
  );
});
