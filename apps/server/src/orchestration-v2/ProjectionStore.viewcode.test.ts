import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// ViewCode guard (f1f8cfe56): a provider-native subagent's own thread never gets a run, so
// clients read that it is working from its lead's shell. Both shell builders, in memory and
// from SQL, must fill runningSubagentThreadIds.

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells name the subagent threads the lead is running", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:running-subagents");
    const runId = RunId.make("run:running-subagents");
    const rootNodeId = NodeId.make("node:running-subagents");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:running-subagents"),
      rootNodeId,
      activeAttemptId: null,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* store.apply({
      id: EventId.make("event:running-subagents:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:running-subagents"),
        title: "Lead",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* store.apply({
      id: EventId.make("event:running-subagents:run"),
      type: "run.created",
      threadId,
      runId,
      nodeId: rootNodeId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: run,
    });
    const subagent = (index: number, status: "running" | "completed") => ({
      id: TurnItemId.make(`item:running-subagents:${index}`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status,
      title: `Research ${index}`,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
      type: "subagent" as const,
      subagentId: NodeId.make(`node:running-subagents:${index}`),
      origin: "provider_native" as const,
      driver,
      providerInstanceId,
      childThreadId: ThreadId.make(`thread:running-subagents:child-${index}`),
      prompt: `Research ${index}`,
      result: null,
    });
    const setItem = (index: number, status: "running" | "completed") =>
      store.apply({
        id: EventId.make(`event:running-subagents:${index}:${status}`),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: subagent(index, status),
      });
    const assertRunning = Effect.fnUntraced(function* (expected: ReadonlyArray<string>) {
      const listed = (yield* store.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      for (const shell of [yield* store.getThreadShell(threadId), listed]) {
        assert.deepEqual([...(shell?.runningSubagentThreadIds ?? [])].toSorted(), expected);
      }
    });
    yield* setItem(1, "running");
    yield* setItem(2, "running");
    // The lead's own run is still active, so nothing is "pending background work" yet.
    yield* assertRunning(["thread:running-subagents:child-1", "thread:running-subagents:child-2"]);
    yield* setItem(1, "completed");
    yield* assertRunning(["thread:running-subagents:child-2"]);
  }).pipe(Effect.provide(layer)),
);
