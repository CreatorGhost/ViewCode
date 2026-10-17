import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { nextThreadGoal } from "./threadGoal.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

describe("nextThreadGoal", () => {
  const active = { objective: "Ship it", pausedAt: null, updatedAt: T0 };
  const paused = { ...active, pausedAt: T0 };

  it("sets, clears and leaves the goal alone", () => {
    expect(nextThreadGoal(null, { goal: "Ship it" }, T1)).toEqual({ ...active, updatedAt: T1 });
    expect(nextThreadGoal(active, { goal: null }, T1)).toBeNull();
    expect(nextThreadGoal(active, {}, T1)).toBeUndefined();
    expect(nextThreadGoal(null, { goalPaused: true }, T1)).toBeUndefined();
  });

  it("keeps a paused goal paused when only its text changes", () => {
    expect(nextThreadGoal(paused, { goal: "Ship it well" }, T1)).toEqual({
      objective: "Ship it well",
      pausedAt: T0,
      updatedAt: T1,
    });
    expect(nextThreadGoal(paused, { goal: "Ship it well", goalPaused: false }, T1)).toEqual({
      objective: "Ship it well",
      pausedAt: null,
      updatedAt: T1,
    });
  });

  it("pauses and resumes, and ignores a pause that changes nothing", () => {
    expect(nextThreadGoal(active, { goalPaused: true }, T1)).toEqual({
      ...active,
      pausedAt: T1,
      updatedAt: T1,
    });
    expect(nextThreadGoal(paused, { goalPaused: true }, T1)).toBeUndefined();
    expect(nextThreadGoal(paused, { goalPaused: false }, T1)).toEqual({
      ...active,
      updatedAt: T1,
    });
  });
});

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-goal-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("thread goal and debug mode", (it) => {
  it.effect("are stored on the thread and reach its shell and detail", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.make("project-goal");
      const threadId = ThreadId.make("thread-goal");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-goal-project"),
        projectId,
        title: "Goal",
        workspaceRoot: "/tmp/project-goal",
        defaultModelSelection: modelSelection,
        createdAt: T0,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-goal-thread"),
        threadId,
        projectId,
        title: "Goal thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: T0,
      });
      const read = Effect.gen(function* () {
        const shell = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
        assert.deepEqual(
          { goal: detail.goal, debugMode: detail.debugMode },
          { goal: shell.goal, debugMode: shell.debugMode },
        );
        return shell;
      });

      // A thread with neither carries neither, so older clients see no change.
      const fresh = yield* read;
      assert.isUndefined(fresh.goal);
      assert.isUndefined(fresh.debugMode);

      // Pausing needs a goal.
      const refused = yield* Effect.flip(
        engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-pause-none"),
          threadId,
          goalPaused: true,
        }),
      );
      expect(refused.message).toContain("has no goal to pause");

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-goal-set"),
        threadId,
        goal: "All tests in packages/api pass",
        debugMode: true,
      });
      const set = yield* read;
      expect(set.goal).toMatchObject({
        objective: "All tests in packages/api pass",
        pausedAt: null,
      });
      expect(set.debugMode).toBe(true);

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-goal-pause"),
        threadId,
        goalPaused: true,
      });
      const paused = yield* read;
      expect(paused.goal?.objective).toBe("All tests in packages/api pass");
      expect(paused.goal?.pausedAt).toEqual(expect.any(String));

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-goal-clear"),
        threadId,
        goal: null,
        debugMode: false,
      });
      const cleared = yield* read;
      assert.isUndefined(cleared.goal);
      assert.isUndefined(cleared.debugMode);
    }),
  );
});
