import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { v2ThreadShell } from "../../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Goals from "../../../orchestration-v2/ViewCodeGoals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GoalHandlers from "./handlers.ts";
import { GoalToolkit, SET_GOAL_TOOL_DESCRIPTION } from "./tools.ts";

const makeHarness = Effect.gen(function* () {
  const shell = yield* Ref.make({
    ...v2ThreadShell,
    status: "running" as const,
    activeRunId: RunId.make("run:goal"),
  });
  const commands = yield* Ref.make<OrchestrationV2ServerCommand[]>([]);
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Ref.get(shell),
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* Ref.update(commands, (items) => [...items, command]);
        if (command.type === "thread.metadata.update")
          yield* Ref.update(shell, (current) => ({
            ...current,
            ...(command.viewcodeGoal === undefined ? {} : { viewcodeGoal: command.viewcodeGoal }),
            ...(command.debugMode === undefined ? {} : { debugMode: command.debugMode }),
          }));
        return { sequence: 1, storedEvents: [] };
      }),
  });
  const services = Layer.mergeAll(threads, NodeCrypto.layer);
  const goals = Goals.layer.pipe(Layer.provide(services));
  const toolkit = yield* GoalToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(GoalHandlers.layer)),
  );
  const scope = (
    capabilities: McpInvocationContext.McpCapability[],
    thread = true,
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:goal-test"),
    requestNamespace: "goal-test",
    issuedAt: 1,
    thread: thread
      ? {
          threadId: v2ThreadShell.id,
          providerSessionId: "goal-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
    client: undefined,
    capabilities: new Set(capabilities),
  });
  const call = <Name extends keyof typeof GoalToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: McpInvocationContext.McpCapability[] = ["orchestration"],
    thread = true,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as Tool.Success<(typeof GoalToolkit.tools)[Name]>),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope(capabilities, thread)),
      Effect.provide(Layer.mergeAll(services, goals)),
    );
  const service = yield* Goals.ViewCodeGoals.pipe(Effect.provide(goals));
  return { commands, shell, call, service };
});

describe("ViewCode goal toolkit on v2", () => {
  it("keeps the explicit-user-goal rule", () => {
    expect(SET_GOAL_TOOL_DESCRIPTION).toContain(
      "Only set or change a goal when the user has explicitly stated one",
    );
    expect(SET_GOAL_TOOL_DESCRIPTION).toContain("Never infer, invent or reword a goal");
  });
  it.effect(
    "sets, pauses, edits, resumes and clears the caller's goal without changing upstream's native goal",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* Ref.update(h.shell, (shell) => ({
          ...shell,
          goal: { objective: "Provider goal", status: "active" as const },
        }));
        expect(yield* h.call("viewcode_get_goal", {})).toEqual({ goal: null });
        expect((yield* Effect.flip(h.call("viewcode_set_goal", { paused: true })))._tag).toBe(
          "ThreadGoalMissingError",
        );
        expect(yield* Ref.get(h.commands)).toEqual([]);
        expect(yield* h.call("viewcode_set_goal", { objective: "  CI is green  " })).toEqual({
          goal: { objective: "CI is green", paused: false },
        });
        expect(yield* h.call("viewcode_set_goal", { paused: true })).toEqual({
          goal: { objective: "CI is green", paused: true },
        });
        expect(yield* h.call("viewcode_set_goal", { objective: "Ship the whole change" })).toEqual({
          goal: { objective: "Ship the whole change", paused: true },
        });
        expect(yield* h.call("viewcode_set_goal", { paused: false })).toEqual({
          goal: { objective: "Ship the whole change", paused: false },
        });
        expect(yield* h.call("viewcode_set_goal", { objective: null })).toEqual({ goal: null });
        expect(
          (yield* Ref.get(h.commands)).every(
            (command) => command.type === "thread.metadata.update",
          ),
        ).toBe(true);
        expect((yield* Ref.get(h.shell)).goal).toEqual({
          objective: "Provider goal",
          status: "active",
        });
      }),
  );
  it.effect("sets debug mode both ways and avoids redundant metadata events", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      expect(yield* h.call("viewcode_get_debug_mode", {})).toEqual({ enabled: false });
      expect(yield* h.call("viewcode_set_debug_mode", { enabled: true })).toEqual({
        enabled: true,
      });
      yield* h.call("viewcode_set_debug_mode", { enabled: true });
      expect((yield* Ref.get(h.commands)).length).toBe(1);
      expect(yield* h.call("viewcode_set_debug_mode", { enabled: false })).toEqual({
        enabled: false,
      });
    }),
  );
  it.effect(
    "validates objectives for every caller and preserves unchanged goals without more events",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        for (const objective of ["   ", "x".repeat(2001)]) {
          expect((yield* Effect.flip(h.service.set(v2ThreadShell.id, { objective })))._tag).toBe(
            "ThreadGoalInvalidObjectiveError",
          );
        }
        expect(yield* Ref.get(h.commands)).toEqual([]);
        const first = yield* h.service.set(v2ThreadShell.id, { objective: "Finish the port" });
        const second = yield* h.service.set(v2ThreadShell.id, { objective: "Finish the port" });
        expect(second).toBe(first);
        expect((yield* Ref.get(h.commands)).length).toBe(1);
      }),
  );

  it.effect("refuses missing capability and external callers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      expect((yield* Effect.flip(h.call("viewcode_get_goal", {}, ["preview"])))._tag).toBe(
        "McpCapabilityUnavailableError",
      );
      expect(
        (yield* Effect.flip(h.call("viewcode_get_goal", {}, ["orchestration"], false)))._tag,
      ).toBe("OrchestratorMcpFailure");
      expect(yield* Ref.get(h.commands)).toEqual([]);
    }),
  );
});
