import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/**
 * Whether a turn was asked for by a person: its message was sent from a client, not by the
 * server on someone's behalf (agent messages, child agents, pull request watch wakes, usage
 * resume, a server-started review). Agent tools that act outside ViewCode for the user, such as
 * posting a review, run only in such a turn.
 *
 * It reads the event store's own record of who dispatched the message (`actor_kind`, from the
 * command id) rather than adding a field: every turn already has one. The first event for the
 * message counts, because a turn replayed after compaction is re-sent by the server under the
 * same message id.
 */
export class TurnOrigin extends Context.Service<
  TurnOrigin,
  {
    /** False when the turn, its message or its event cannot be found. */
    readonly startedByUser: (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    }) => Effect.Effect<boolean>;
  }
>()("t3/orchestration/TurnOrigin") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const actorOfTurnMessage = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, turnId: Schema.String }),
    Result: Schema.Struct({ actorKind: Schema.String }),
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT e.actor_kind AS "actorKind"
        FROM projection_turns t
        JOIN orchestration_events e
          ON e.aggregate_kind = 'thread'
          AND e.stream_id = t.thread_id
          AND e.event_type = 'thread.message-sent'
          AND json_extract(e.payload_json, '$.messageId') = t.pending_message_id
          AND json_extract(e.payload_json, '$.role') = 'user'
        WHERE t.thread_id = ${threadId}
          AND t.turn_id = ${turnId}
        ORDER BY e.sequence ASC
        LIMIT 1
      `,
  });

  return TurnOrigin.of({
    startedByUser: (input) =>
      actorOfTurnMessage(input).pipe(
        Effect.map((row) => Option.isSome(row) && row.value.actorKind === "client"),
        Effect.catch((error) =>
          Effect.logWarning("Could not read who started a turn", { detail: error.message }).pipe(
            Effect.as(false),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(TurnOrigin, make);
