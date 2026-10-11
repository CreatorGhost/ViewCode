import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as TurnOrigin from "./TurnOrigin.ts";

const NOW = "2026-09-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-origin");

const layer = it.layer(
  Layer.mergeAll(TurnOrigin.layer, OrchestrationEventStoreLive, ProjectionTurnRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

/** A user message sent by the command id a client or the server dispatches it with. */
const userMessage = (
  messageId: string,
  commandId: string,
  sequenceTag: string,
): Omit<OrchestrationEvent, "sequence"> => ({
  type: "thread.message-sent",
  eventId: EventId.make(`event-${messageId}-${sequenceTag}`),
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
  occurredAt: NOW,
  commandId: CommandId.make(commandId),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: THREAD_ID,
    messageId: MessageId.make(messageId),
    role: "user",
    text: "post the blockers",
    turnId: null,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

const turnOf = (turnId: string, messageId: string) => ({
  threadId: THREAD_ID,
  turnId: TurnId.make(turnId),
  pendingMessageId: MessageId.make(messageId),
  sourceProposedPlanThreadId: null,
  sourceProposedPlanId: null,
  assistantMessageId: null,
  state: "running" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  checkpointTurnCount: null,
  checkpointRef: null,
  checkpointStatus: null,
  checkpointFiles: [],
});

layer("TurnOrigin", (it) => {
  it.effect("tells a turn a person asked for from turns the server started", () =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore;
      const turns = yield* ProjectionTurnRepository;
      const origin = yield* TurnOrigin.TurnOrigin;

      // A person typed it; after compaction the server re-sends the same message.
      yield* events.append(userMessage("human", "6f1c2a90-client-command", "1"));
      yield* events.append(userMessage("human", "server:after-compaction:1", "2"));
      yield* turns.upsertByTurnId(turnOf("turn-human", "human"));
      // Another agent's message, a child agent's brief, a pull request watch wake.
      yield* events.append(userMessage("agent", "server:agent-message:agent", "1"));
      yield* turns.upsertByTurnId(turnOf("turn-agent", "agent"));
      // A review the server started.
      yield* events.append(userMessage("review", "server:pr-review-turn:x", "1"));
      yield* turns.upsertByTurnId(turnOf("turn-review", "review"));

      const startedByUser = (turnId: string) =>
        origin.startedByUser({ threadId: THREAD_ID, turnId: TurnId.make(turnId) });
      assert.isTrue(yield* startedByUser("turn-human"));
      assert.isFalse(yield* startedByUser("turn-agent"));
      assert.isFalse(yield* startedByUser("turn-review"));
      assert.isFalse(yield* startedByUser("turn-unknown"));
    }),
  );
});
