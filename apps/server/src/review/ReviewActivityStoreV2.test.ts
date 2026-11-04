import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ReviewActivityStore from "./ReviewActivityStoreV2.ts";

const layer = ReviewActivityStore.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer))),
  ),
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("persists review findings in v2 events and projections with an idempotent receipt", () =>
  Effect.gen(function* () {
    const reviews = yield* ReviewActivityStore.ReviewActivityStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:review-v2");
    const instanceId = ProviderInstanceId.make("codex");
    yield* sink.write({
      events: [
        {
          type: "thread.created",
          id: EventId.make("review:thread-created"),
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project:review-v2"),
            title: "Review",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "gpt-6" },
            createdBy: "user",
            creationSource: "server",
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
        },
      ],
    });
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("review:findings"),
      tone: "info",
      kind: "viewcode.review.findings",
      summary: "Review findings",
      payload: {
        findings: [{ title: "Preserve account routing", path: "routing.ts", severity: "P1" }],
        complete: false,
      },
      turnId: null,
      createdAt: DateTime.formatIso(now),
    };
    const command = { commandId: CommandId.make("review:record-findings"), threadId, activity };
    yield* reviews.append(command);
    yield* reviews.append(command);
    expect(yield* reviews.list(threadId)).toEqual([activity]);
    expect(yield* reviews.list(threadId, ["other"])).toEqual([]);
    expect(yield* reviews.listByKind("viewcode.review.findings")).toEqual([activity]);
    const projection = yield* projections.getThreadRecords(threadId, ["turnItems"]);
    expect(projection.turnItems).toHaveLength(1);
    expect(projection.turnItems[0]).toMatchObject({
      type: "system_notice",
      runId: null,
      viewcodeActivity: activity,
    });
    const rows = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id = ${command.commandId}`;
    // The canonical application event store carries the notice once, even after a retry.
    expect(rows[0]?.count).toBe(1);
  }).pipe(Effect.provide(layer)),
);
