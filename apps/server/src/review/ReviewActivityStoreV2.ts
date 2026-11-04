import {
  type CommandId,
  EventId,
  OrchestrationThreadActivity,
  type ThreadId,
  TurnItemId,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

export class ReviewActivityError extends Schema.TaggedError<ReviewActivityError>()(
  "ReviewActivityError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} review activity.`;
  }
}

export class ReviewActivityStoreV2 extends Context.Service<
  ReviewActivityStoreV2,
  {
    readonly append: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly activity: OrchestrationThreadActivity;
    }) => Effect.Effect<void, ReviewActivityError>;
    readonly list: (
      threadId: ThreadId,
      kinds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ReviewActivityError>;
    readonly listByKind: (
      kind: string,
    ) => Effect.Effect<ReadonlyArray<OrchestrationThreadActivity>, ReviewActivityError>;
  }
>()("t3/review/ReviewActivityStoreV2") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sql = yield* SqlClient.SqlClient;
  const append: ReviewActivityStoreV2["Service"]["append"] = (input) =>
    executor
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          yield* projections.getThread(input.threadId);
          const now = yield* DateTime.now;
          const ordinal = yield* projections.getNextTurnItemOrdinal(input.threadId);
          yield* sink.commitCommand({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: "viewcode.review.activity.append",
            acceptedAt: now,
            effects: [],
            events: [
              {
                type: "turn-item.updated",
                id: EventId.make(`viewcode:activity:${input.activity.id}`),
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  type: "system_notice",
                  id: TurnItemId.make(`viewcode:activity:${input.activity.id}`),
                  threadId: input.threadId,
                  runId: input.activity.turnId === null ? null : RunId.make(input.activity.turnId),
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  status: "completed",
                  title: input.activity.summary,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  message: input.activity.summary,
                  viewcodeActivity: input.activity,
                },
              },
            ],
          });
        }),
      )
      .pipe(Effect.mapError((cause) => new ReviewActivityError({ operation: "record", cause })));

  const list: ReviewActivityStoreV2["Service"]["list"] = (threadId, kinds) =>
    projections.getThreadRecords(threadId, ["turnItems"]).pipe(
      Effect.map((records) =>
        records.turnItems.flatMap((item) =>
          item.type === "system_notice" &&
          item.viewcodeActivity !== undefined &&
          (kinds === undefined || kinds.includes(item.viewcodeActivity.kind))
            ? [item.viewcodeActivity]
            : [],
        ),
      ),
      Effect.mapError((cause) => new ReviewActivityError({ operation: "read", cause })),
    );

  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationThreadActivity));
  const listByKind: ReviewActivityStoreV2["Service"]["listByKind"] = (kind) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly activity: string }>`
      SELECT json_extract(payload_json, '$.viewcodeActivity') AS activity
      FROM orchestration_v2_projection_turn_items
      WHERE json_extract(payload_json, '$.viewcodeActivity.kind') = ${kind}
      ORDER BY json_extract(payload_json, '$.viewcodeActivity.createdAt'), ordinal
    `;
      return yield* Effect.forEach(rows, (row) => decode(row.activity));
    }).pipe(Effect.mapError((cause) => new ReviewActivityError({ operation: "list", cause })));
  return ReviewActivityStoreV2.of({ append, list, listByKind });
});

export const layer = Layer.effect(ReviewActivityStoreV2, make);
