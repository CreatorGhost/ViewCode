import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch.
const FUTURE_WAKE = "1970-01-02T09:00:00.000Z";

function makeThread(id: string, overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

// lead -> child -> grandchild, plus an unrelated top-level thread.
function makeReadModel(overrides: Record<string, Partial<OrchestrationThread>> = {}) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [
      makeThread("lead", overrides.lead),
      makeThread("child", { parentThreadId: ThreadId.make("lead"), ...overrides.child }),
      makeThread("grandchild", {
        parentThreadId: ThreadId.make("child"),
        ...overrides.grandchild,
      }),
      makeThread("other", overrides.other),
    ],
    updatedAt: NOW,
  };
  return readModel;
}

const threadIdsOf = (result: unknown) =>
  (Array.isArray(result) ? result : [result]).map((event) => ({
    type: event.type as string,
    threadId: String(event.payload.threadId),
  }));

it.layer(NodeServices.layer)("child agent cascade", (it) => {
  it.effect("archiving a lead archives its whole agent tree and nothing else", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive"),
          threadId: ThreadId.make("lead"),
        },
        readModel: makeReadModel(),
      });
      expect(threadIdsOf(result)).toEqual([
        { type: "thread.archived", threadId: "lead" },
        { type: "thread.archived", threadId: "child" },
        { type: "thread.archived", threadId: "grandchild" },
      ]);
    }),
  );

  it.effect("skips children that are already archived", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive"),
          threadId: ThreadId.make("lead"),
        },
        readModel: makeReadModel({ child: { archivedAt: NOW } }),
      });
      expect(threadIdsOf(result)).toEqual([
        { type: "thread.archived", threadId: "lead" },
        { type: "thread.archived", threadId: "grandchild" },
      ]);
    }),
  );

  it.effect("unarchiving a lead brings its archived children back", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.make("cmd-unarchive"),
          threadId: ThreadId.make("lead"),
        },
        readModel: makeReadModel({
          lead: { archivedAt: NOW },
          child: { archivedAt: NOW },
          grandchild: { archivedAt: NOW },
        }),
      });
      expect(threadIdsOf(result)).toEqual([
        { type: "thread.unarchived", threadId: "lead" },
        { type: "thread.unarchived", threadId: "child" },
        { type: "thread.unarchived", threadId: "grandchild" },
      ]);
    }),
  );

  it.effect("snoozing a lead snoozes children, leaving ones blocked on the user", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze"),
          threadId: ThreadId.make("lead"),
          snoozedUntil: FUTURE_WAKE,
        },
        readModel: makeReadModel({
          grandchild: {
            activities: [
              {
                id: EventId.make("activity-approval"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Approval",
                payload: { requestId: "request-1", requestKind: "command" },
                turnId: null,
                createdAt: NOW,
              },
            ],
          },
        }),
      });
      expect(threadIdsOf(result)).toEqual([
        { type: "thread.snoozed", threadId: "lead" },
        { type: "thread.snoozed", threadId: "child" },
      ]);
    }),
  );

  it.effect("waking a lead wakes its snoozed children", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsnooze",
          commandId: CommandId.make("cmd-unsnooze"),
          threadId: ThreadId.make("lead"),
          reason: "user",
        },
        readModel: makeReadModel({
          lead: { snoozedUntil: FUTURE_WAKE, snoozedAt: NOW },
          child: { snoozedUntil: FUTURE_WAKE, snoozedAt: NOW },
        }),
      });
      expect(threadIdsOf(result)).toEqual([
        { type: "thread.unsnoozed", threadId: "lead" },
        { type: "thread.unsnoozed", threadId: "child" },
      ]);
    }),
  );
});
