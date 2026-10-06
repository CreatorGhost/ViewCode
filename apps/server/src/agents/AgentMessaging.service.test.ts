import {
  type AgentControlSnapshot,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { parseAgentMessage } from "@t3tools/shared/agentMessages";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  AGENT_CONTINUE_PROMPT,
  AGENT_MESSAGE_MAX_HOPS,
  AgentMessaging,
  UNKNOWN_RESET_RETRY_MS,
  USAGE_RESET_CONTINUE_PROMPT,
  isLimitError,
  layer,
} from "./AgentMessaging.ts";

type TurnStart = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

const LEAD = ThreadId.make("lead");
const CHILD = ThreadId.make("child");
const LONER = ThreadId.make("loner");

let counter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    counter += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, counter);
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

interface Message {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: string | null;
}

/**
 * A fake engine: a turn start publishes `thread.turn-start-requested` and
 * then the provider turn starting (`session-set` running with a fresh turn
 * id); `endTurn` writes the turn's answer and publishes its end.
 */
const makeHarness = Effect.gen(function* () {
  const activeTurn = yield* Ref.make(new Map<string, string>());
  const messages = yield* Ref.make(new Map<string, ReadonlyArray<Message>>());
  const errors = yield* Ref.make(new Map<string, string>());
  const models = yield* Ref.make(new Map<string, string>());
  /** Provider instance per thread; claudeAgent unless a test moves one. */
  const instances = yield* Ref.make(new Map<string, string>());
  /** Threads the user archived. */
  const archivedIds = new Set<string>();
  /** The claudeAgent instance's usage windows, once a test publishes a reading. */
  const usage = yield* Ref.make<
    | {
        readonly checkedAt: string;
        readonly windows: ReadonlyArray<{ usedPercent: number; resetsAt?: string }>;
      }
    | undefined
  >(undefined);
  const providerChanges = yield* PubSub.unbounded<ReadonlyArray<unknown>>();
  const turnStarts = yield* Ref.make<ReadonlyArray<TurnStart>>([]);
  const interrupts = yield* Ref.make<ReadonlyArray<string>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  let turnCounter = 0;
  let uuidBarrier:
    | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;
  const crypto = {
    ...testCrypto,
    randomUUIDv4: Effect.suspend(() => {
      const barrier = uuidBarrier;
      uuidBarrier = undefined;
      return barrier
        ? Deferred.succeed(barrier.entered, undefined).pipe(
            Effect.andThen(Deferred.await(barrier.release)),
            Effect.andThen(testCrypto.randomUUIDv4),
          )
        : testCrypto.randomUUIDv4;
    }),
  };

  const publish = (event: unknown) => PubSub.publish(events, event as OrchestrationEvent);

  const addMessage = (threadId: ThreadId, message: Message) =>
    Ref.update(messages, (map) =>
      new Map(map).set(threadId, [...(map.get(threadId) ?? []), message]),
    );

  /** The provider turn for a requested message starts. */
  const runTurn = (threadId: ThreadId, messageId: string, text: string, accepted = false) =>
    Effect.gen(function* () {
      turnCounter += 1;
      const turnId = `turn-${turnCounter}`;
      yield* publish({ type: "thread.turn-start-requested", payload: { threadId, messageId } });
      yield* addMessage(threadId, { role: "user", text, turnId: null });
      yield* Ref.update(activeTurn, (map) => new Map(map).set(threadId, turnId));
      yield* publish({
        type: "thread.session-set",
        payload: { threadId, session: { threadId, status: "running", activeTurnId: turnId } },
      });
      if (accepted) yield* acceptTurn(threadId, messageId, turnId);
      return turnId;
    });

  const acceptTurn = (threadId: ThreadId, messageId: string, turnId: string) =>
    publish({
      type: "thread.activity-appended",
      payload: {
        threadId,
        activity: {
          kind: "provider.turn.start.accepted",
          payload: { requestId: messageId },
          turnId,
        },
      },
    });
  const delayedStarts = new Set<string>();
  /** Model selections written by thread.create and thread.meta.update, in order. */
  const selections: Array<{ type: string; threadId: string; modelSelection?: unknown }> = [];

  const dispatch = (command: OrchestrationCommand) => {
    if (command.type === "thread.create" || command.type === "thread.meta.update") {
      selections.push({
        type: command.type,
        threadId: command.threadId,
        modelSelection: command.modelSelection,
      });
    }
    switch (command.type) {
      case "thread.turn.start":
        return Ref.update(turnStarts, (all) => [...all, command]).pipe(
          Effect.andThen(
            delayedStarts.has(command.threadId)
              ? publish({
                  type: "thread.turn-start-requested",
                  payload: {
                    threadId: command.threadId,
                    messageId: command.message.messageId,
                  },
                }).pipe(Effect.asVoid)
              : runTurn(
                  command.threadId,
                  command.message.messageId,
                  command.message.text,
                  true,
                ).pipe(Effect.asVoid),
          ),
          Effect.as({ sequence: 1 }),
        );
      case "thread.turn.interrupt":
        return Ref.update(interrupts, (all) => [...all, command.threadId]).pipe(
          Effect.andThen(
            publish({
              type: "thread.turn-interrupt-requested",
              commandId: command.commandId,
              payload: { threadId: command.threadId },
            }),
          ),
          Effect.as({ sequence: 1 }),
        );
      case "thread.meta.update":
        return Ref.update(models, (map) =>
          command.modelSelection
            ? new Map(map).set(command.threadId, command.modelSelection.model)
            : map,
        ).pipe(Effect.as({ sequence: 1 }));
      default:
        return Effect.succeed({ sequence: 1 });
    }
  };

  const shell = (
    id: ThreadId,
    parentThreadId: ThreadId | null,
    turnId: string | undefined,
    lastError: string | undefined,
    model: string | undefined,
    instanceId = "claudeAgent",
  ) =>
    ({
      id,
      projectId: "project",
      title: id === LEAD ? "Lead" : id === CHILD ? "Child" : "Loner",
      modelSelection: { instanceId, model: model ?? "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      archivedAt: archivedIds.has(id) ? "2026-01-01T00:00:00.000Z" : null,
      parentThreadId,
      latestTurn: turnId || lastError ? null : { turnId: "earlier-turn", state: "completed" },
      session: turnId
        ? {
            threadId: id,
            status: "running",
            activeTurnId: turnId,
            providerInstanceId: instanceId,
            lastError: null,
          }
        : {
            threadId: id,
            status: lastError ? "error" : "ready",
            activeTurnId: null,
            providerInstanceId: instanceId,
            lastError: lastError ?? null,
          },
    }) as unknown as OrchestrationThreadShell;

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.all([
          Ref.get(activeTurn),
          Ref.get(errors),
          Ref.get(models),
          Ref.get(instances),
        ]).pipe(
          Effect.map(([turns, failed, chosen, where]) => ({
            snapshotSequence: 1,
            projects: [],
            threads: [
              shell(
                LEAD,
                null,
                turns.get(LEAD),
                failed.get(LEAD),
                chosen.get(LEAD),
                where.get(LEAD),
              ),
              shell(
                CHILD,
                LEAD,
                turns.get(CHILD),
                failed.get(CHILD),
                chosen.get(CHILD),
                where.get(CHILD),
              ),
              shell(
                LONER,
                null,
                turns.get(LONER),
                failed.get(LONER),
                chosen.get(LONER),
                where.get(LONER),
              ),
            ],
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
        ),
      getThreadDetailById: (threadId) =>
        Ref.get(messages).pipe(
          Effect.map((map) =>
            Option.some({
              messages: (map.get(threadId) ?? []).map((message) => ({
                ...message,
                streaming: false,
                createdAt: "2026-01-01T00:00:00.000Z",
              })),
            } as unknown as OrchestrationThread),
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderRegistry)({
      streamChanges: Stream.unwrap(
        PubSub.subscribe(providerChanges).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      ) as never,
      getProviders: Ref.get(usage).pipe(
        Effect.map(
          (reading) =>
            [
              {
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                enabled: true,
                status: "ready",
                ...(reading ? { usageLimits: reading } : {}),
                models: [{ slug: "claude-sonnet-4-6", name: "Sonnet" }],
              },
              {
                instanceId: "codex",
                driver: "codex",
                enabled: true,
                status: "ready",
                models: [
                  {
                    slug: "gpt-5.4",
                    name: "GPT-5.4",
                    isDefault: true,
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "reasoningEffort",
                          label: "Reasoning",
                          type: "select",
                          options: [
                            { id: "low", label: "Low" },
                            { id: "medium", label: "Medium", isDefault: true },
                            { id: "high", label: "High" },
                            { id: "xhigh", label: "Extra High" },
                          ],
                        },
                        {
                          id: "serviceTier",
                          label: "Service tier",
                          type: "select",
                          options: [
                            { id: "default", label: "Standard", isDefault: true },
                            { id: "priority", label: "Fast" },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ] as never,
        ),
      ),
    }),
    Layer.succeed(ServerActivation, undefined),
    Layer.succeed(Crypto.Crypto, crypto),
  );

  /** The thread's running turn ends, optionally with a final answer. */
  const endTurn = (threadId: ThreadId, answer?: string, status = "ready") =>
    Effect.gen(function* () {
      const turnId = (yield* Ref.get(activeTurn)).get(threadId) ?? null;
      if (answer !== undefined)
        yield* addMessage(threadId, { role: "assistant", text: answer, turnId });
      yield* Ref.update(activeTurn, (map) => {
        const next = new Map(map);
        next.delete(threadId);
        return next;
      });
      yield* publish({
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status,
            activeTurnId: null,
            lastError: (yield* Ref.get(errors)).get(threadId) ?? null,
          },
        },
      });
    });

  /** The user types a prompt into the thread; its turn starts at once. */
  const userPrompt = (threadId: ThreadId, text: string) => {
    counter += 1;
    return runTurn(threadId, `user-message-${counter}`, text);
  };

  const starts = Ref.get(turnStarts);

  const clientInterrupt = (threadId: ThreadId) =>
    publish({ type: "thread.turn-interrupt-requested", payload: { threadId } });

  return {
    blockNextUuid: (barrier: {
      entered: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
    }) => {
      uuidBarrier = barrier;
    },
    acceptTurn,
    rejectTurn: (threadId: ThreadId, messageId: string, detail: string) =>
      publish({
        type: "thread.activity-appended",
        payload: {
          threadId,
          activity: {
            kind: "provider.turn.start.failed",
            payload: { requestId: messageId, detail },
            turnId: null,
          },
        },
      }),
    delayedStarts,
    runTurn,
    errors,
    models,
    instances,
    archivedIds,
    /** A fresh usage reading for claudeAgent reaches the service. */
    publishUsage: (
      windows: ReadonlyArray<{ usedPercent: number; resetsAt?: string }>,
      checkedAt = "2026-01-01T00:00:00.000Z",
    ) =>
      Ref.set(usage, { checkedAt, windows }).pipe(
        Effect.andThen(
          PubSub.publish(providerChanges, [
            { instanceId: "claudeAgent", usageLimits: { checkedAt, windows } },
          ]),
        ),
      ),
    selections,
    interrupts,
    starts,
    endTurn,
    userPrompt,
    clientInterrupt,
    events,
    layer: layer.pipe(Layer.provide(dependencies)),
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Runs `body` against a started AgentMessaging service. */
const withMessaging = <A, E>(
  body: (
    harness: Harness,
    messaging: AgentMessaging["Service"],
    settle: Effect.Effect<void>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      return yield* Effect.gen(function* () {
        const messaging = yield* AgentMessaging;
        yield* messaging.start();
        // Let the event stream reach the worker, then wait for the worker.
        const settle = Effect.yieldNow.pipe(Effect.andThen(messaging.drain));
        return yield* body(harness, messaging, settle);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

const bodyOf = (start: TurnStart | undefined) => parseAgentMessage(start?.message.text ?? "")?.body;

describe("AgentMessaging", () => {
  it.effect("wakes an idle receiver and routes its final answer back to the sender", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        const sent = yield* messaging.sendMessage(LEAD, {
          to: "Child",
          message: "Audit the frontend.",
          replyExpected: true,
        });
        assert.equal(sent.delivery, "started");
        const [wake] = yield* harness.starts;
        assert.equal(wake?.threadId, CHILD);
        const envelope = parseAgentMessage(wake?.message.text ?? "");
        assert.equal(envelope?.fromThreadId, LEAD);
        assert.isTrue(envelope?.replyExpected);

        yield* settle;
        yield* harness.endTurn(CHILD, "3 gaps found.");
        yield* settle;

        const starts = yield* harness.starts;
        assert.equal(starts.length, 2);
        const reply = parseAgentMessage(starts[1]!.message.text);
        assert.equal(starts[1]!.threadId, LEAD);
        assert.equal(reply?.body, "3 gaps found.");
        assert.equal(reply?.inReplyTo, sent.messageId);
      }),
    ),
  );

  it.effect("routes the answer of the delivery's own turn when a user prompt interleaves", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* messaging.sendMessage(LEAD, {
          to: CHILD,
          message: "Audit the frontend.",
          replyExpected: true,
        });
        // The delivery's turn ends and the user prompts the child before the
        // worker has handled that end; the user's turn answers first.
        yield* harness.endTurn(CHILD, "Frontend: 3 gaps.");
        yield* harness.userPrompt(CHILD, "Also, what time is it?");
        yield* harness.endTurn(CHILD, "It is noon.");
        yield* settle;

        const toLead = (yield* harness.starts).filter((start) => start.threadId === LEAD);
        assert.equal(toLead.length, 1);
        assert.equal(bodyOf(toLead[0]), "Frontend: 3 gaps.");
      }),
    ),
  );

  it.effect("binds an accepted delivery to its own turn despite an earlier late user turn", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        harness.delayedStarts.add(CHILD);
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Audit.", replyExpected: true });
        const request = (yield* harness.starts)[0]!;
        yield* harness.runTurn(CHILD, "earlier-user-request", "Earlier question");
        yield* harness.endTurn(CHILD, "Unrelated answer");
        yield* settle;
        assert.equal((yield* harness.starts).length, 1);
        const turnId = yield* harness.runTurn(
          CHILD,
          request.message.messageId,
          request.message.text,
        );
        yield* harness.endTurn(CHILD, "The audit answer");
        yield* settle;
        // Providers may finish before sendTurn resolves with its acceptance receipt.
        yield* harness.acceptTurn(CHILD, request.message.messageId, turnId);
        yield* settle;
        assert.equal(bodyOf((yield* harness.starts)[1]), "The audit answer");
      }),
    ),
  );

  it.effect(
    "finishes an own turn stopped before it was observed running once its receipt arrives",
    () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          harness.delayedStarts.add(CHILD);
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "First", replyExpected: true });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Second" });
          const request = (yield* harness.starts)[0]!;
          // The provider stops before any running session was seen for the turn.
          yield* harness.endTurn(CHILD, undefined, "interrupted");
          yield* settle;
          assert.equal((yield* harness.starts).length, 1);
          yield* harness.acceptTurn(CHILD, request.message.messageId, "turn-never-seen");
          yield* settle;
          const starts = yield* harness.starts;
          assert.equal(
            bodyOf(starts.find((start) => start.threadId === LEAD)),
            "(finished without a written answer)",
          );
          assert.equal(bodyOf(starts.findLast((start) => start.threadId === CHILD)), "Second");
        }),
      ),
  );

  it.effect("matches failed starts by request id and releases queued work", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        harness.delayedStarts.add(CHILD);
        yield* messaging.sendMessage(LEAD, {
          to: CHILD,
          message: "First task",
          replyExpected: true,
        });
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Second task" });
        const request = (yield* harness.starts)[0]!;
        yield* harness.rejectTurn(CHILD, "another-message", "Unrelated failure");
        yield* settle;
        assert.equal((yield* harness.starts).length, 1);
        harness.delayedStarts.delete(CHILD);
        yield* harness.rejectTurn(CHILD, request.message.messageId, "Provider could not start");
        yield* settle;
        const starts = yield* harness.starts;
        assert.include(
          bodyOf(starts.find((start) => start.threadId === LEAD)) ?? "",
          "Provider could not start",
        );
        assert.equal(bodyOf(starts.findLast((start) => start.threadId === CHILD)), "Second task");
      }),
    ),
  );

  it.effect("reports the receiver's error when its turn fails without an answer", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* messaging.sendMessage(LEAD, {
          to: CHILD,
          message: "Run the tests.",
          replyExpected: true,
        });
        yield* Ref.update(harness.errors, (map) =>
          new Map(map).set(CHILD, "403 MODEL_NOT_IN_PLAN"),
        );
        yield* harness.endTurn(CHILD, undefined, "error");
        yield* settle;

        const starts = yield* harness.starts;
        assert.equal(starts.length, 2);
        assert.include(bodyOf(starts[1]) ?? "", "403 MODEL_NOT_IN_PLAN");
      }),
    ),
  );

  const KNOWN_LIMIT = "Claude usage limit reached. Try again in 2h.";
  const UNKNOWN_LIMIT = "Claude usage limit reached. Send the message again once the limit resets.";
  const TWO_HOURS = 2 * 3_600_000;
  const MARGIN = 60_000;
  const setError = (harness: Harness, threadId: ThreadId, message: string | undefined) =>
    Ref.update(harness.errors, (map) => {
      const next = new Map(map);
      if (message === undefined) next.delete(threadId);
      else next.set(threadId, message);
      return next;
    });

  describe("out of usage", () => {
    it.effect("tells the lead when the child resets and queues messages instead of refusing", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Run the Python suite." });
          yield* setError(harness, CHILD, KNOWN_LIMIT);
          yield* harness.endTurn(CHILD, undefined, "error");
          yield* settle;

          const starts = yield* harness.starts;
          assert.equal(starts.length, 2);
          assert.equal(starts[1]!.threadId, LEAD);
          const failure = bodyOf(starts[1]) ?? "";
          assert.include(failure, "is out of claudeAgent usage until");
          assert.include(failure, "delivered automatically");
          assert.notInclude(failure, "Do not");
          assert.notInclude(failure, "wait for it");

          const queued = yield* messaging.sendMessage(LEAD, {
            to: CHILD,
            message: "Are you still going?",
          });
          assert.equal(queued.delivery, "queued");
          assert.include(queued.note ?? "", "out of usage until");
          assert.include(queued.note ?? "", "last checked");
          assert.include(queued.note ?? "", "delivered automatically");
          assert.notInclude(queued.note ?? "", "Do not");
          assert.equal((yield* harness.starts).length, 2);

          const agent = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
          assert.include(agent?.outOfUsage?.summary ?? "", "out of usage until");
          assert.isDefined(agent?.outOfUsage?.resetsAt);
        }),
      ),
    );

    it.effect("clears the mark when the reset passes and delivers the queue", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
          yield* setError(harness, CHILD, KNOWN_LIMIT);
          yield* harness.endTurn(CHILD, undefined, "error");
          yield* settle;
          assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));

          yield* setError(harness, CHILD, undefined);
          yield* TestClock.adjust(Duration.millis(TWO_HOURS + MARGIN - 1));
          yield* settle;
          assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));
          yield* TestClock.adjust(Duration.millis(1));
          yield* settle;

          assert.equal(bodyOf((yield* harness.starts).at(-1)), "Task two.");
          const agent = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
          assert.isUndefined(agent?.outOfUsage);
        }),
      ),
    );

    it.effect("does not mark an agent out of usage for a transient throttle", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
          yield* setError(
            harness,
            CHILD,
            "API Error: Server is temporarily limiting requests (not your usage limit) · litellm.RateLimitError",
          );
          yield* harness.endTurn(CHILD, undefined, "error");
          yield* settle;

          // The queue is not held back until a reset: the next message goes out now.
          assert.equal(bodyOf((yield* harness.starts).at(-1)), "Task two.");
          const agent = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
          assert.isUndefined(agent?.outOfUsage);
        }),
      ),
    );

    it.effect("starts nothing in an archived agent", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
          harness.archivedIds.add(CHILD);
          yield* harness.endTurn(CHILD, "Done.");
          yield* settle;
          assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));
          const refused = yield* messaging
            .sendMessage(LEAD, { to: CHILD, message: "Task three." })
            .pipe(Effect.flip);
          assert.include(refused.reason, "archived");
          assert.equal(
            yield* messaging.continueAfterLimit(CHILD, MessageId.make("resume-archived"), "usage"),
            "gone",
          );
        }),
      ),
    );

    it.effect(
      "wakes a lead on another provider when the child's reset passes with nothing queued",
      () =>
        withMessaging((harness, messaging, settle) =>
          Effect.gen(function* () {
            yield* Ref.update(harness.instances, (map) => new Map(map).set(LEAD, "codex"));
            yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Audit." });
            yield* setError(harness, CHILD, KNOWN_LIMIT);
            yield* harness.endTurn(CHILD, undefined, "error");
            yield* settle;
            // The failure note started a lead turn; the lead finishes it.
            yield* harness.endTurn(LEAD, "Waiting.");
            yield* settle;
            const before = (yield* harness.starts).length;

            yield* setError(harness, CHILD, undefined);
            yield* TestClock.adjust(Duration.millis(TWO_HOURS + MARGIN));
            yield* settle;

            const starts = yield* harness.starts;
            assert.equal(starts.length, before + 1);
            const notice = starts.at(-1)!;
            assert.equal(notice.threadId, LEAD);
            const body = bodyOf(notice) ?? "";
            assert.include(body, "usage is back");
            assert.include(body, "Child stopped mid-task on the limit");
            assert.include(body, "viewcode_send_message");
            // The child itself is not continued.
            assert.isFalse(starts.slice(before).some((start) => start.threadId === CHILD));
          }),
        ),
    );

    it.effect("clears every mark on the instance after a successful turn there", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
          yield* setError(harness, CHILD, UNKNOWN_LIMIT);
          yield* harness.endTurn(CHILD, undefined, "error");
          yield* settle;
          assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));

          // Another thread on the same provider instance works.
          yield* harness.userPrompt(LONER, "Hello");
          yield* harness.endTurn(LONER, "Hi.");
          yield* settle;

          assert.equal(bodyOf((yield* harness.starts).at(-1)), "Task two.");
          const agent = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
          assert.isUndefined(agent?.outOfUsage);
        }),
      ),
    );

    it.effect("clears the marks when a fresh usage reading shows no spent window", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
          yield* setError(harness, CHILD, UNKNOWN_LIMIT);
          yield* harness.endTurn(CHILD, undefined, "error");
          yield* settle;
          yield* Effect.yieldNow;

          // Still spent: the mark stays, and learns when the window resets.
          yield* harness.publishUsage([{ usedPercent: 97, resetsAt: "1970-01-01T05:00:00.000Z" }]);
          yield* settle;
          const held = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
          assert.equal(held?.outOfUsage?.resetsAt, "1970-01-01T05:00:00.000Z");
          assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));

          yield* harness.publishUsage([{ usedPercent: 40, resetsAt: "1970-01-01T05:00:00.000Z" }]);
          yield* settle;
          assert.equal(bodyOf((yield* harness.starts).at(-1)), "Task two.");
        }),
      ),
    );

    it.effect(
      "holds an unknown reset for ten minutes, then delivers the oldest message as the probe",
      () =>
        withMessaging((harness, messaging, settle) =>
          Effect.gen(function* () {
            yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
            yield* setError(harness, CHILD, UNKNOWN_LIMIT);
            yield* harness.endTurn(CHILD, undefined, "error");
            yield* settle;
            const failure = bodyOf((yield* harness.starts)[1]) ?? "";
            assert.include(failure, "reset time is unknown; retry after");

            const queued = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Probe me." });
            assert.equal(queued.delivery, "queued");
            assert.include(queued.note ?? "", "retrying after");
            assert.include(queued.note ?? "", "last checked");
            const held = (yield* messaging.listAgents(LEAD)).find((entry) => entry.id === CHILD);
            assert.include(held?.outOfUsage?.summary ?? "", "retrying after");

            yield* TestClock.adjust(Duration.millis(UNKNOWN_RESET_RETRY_MS - 1));
            yield* settle;
            assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Probe me."));
            yield* TestClock.adjust(Duration.millis(1));
            yield* settle;
            const probe = (yield* harness.starts).at(-1)!;
            assert.equal(probe.threadId, CHILD);
            assert.equal(bodyOf(probe), "Probe me.");

            // The probe fails with the limit again: the agent is marked afresh.
            yield* harness.endTurn(CHILD, undefined, "error");
            yield* settle;
            const again = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Later." });
            assert.equal(again.delivery, "queued");
            assert.include(again.note ?? "", "retrying after");
          }),
        ),
    );

    it.effect("list_models reports each provider's usage reading", () =>
      withMessaging((harness, messaging) =>
        Effect.gen(function* () {
          yield* harness.publishUsage([{ usedPercent: 99, resetsAt: "2999-01-01T00:00:00.000Z" }]);
          const providers = yield* messaging.listModels();
          const claude = providers.find((entry) => entry.providerId === "claudeAgent");
          assert.isTrue(claude?.usage?.exhausted);
          assert.equal(claude?.usage?.resetsAt, "2999-01-01T00:00:00.000Z");
          assert.isUndefined(providers.find((entry) => entry.providerId === "codex")?.usage);
        }),
      ),
    );
  });

  it.effect("moving an out-of-quota agent to another model starts its queued work", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
        // A second message waits behind the running turn.
        const queued = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
        assert.equal(queued.delivery, "queued");
        yield* Ref.update(harness.errors, (map) =>
          new Map(map).set(CHILD, "You have hit your usage limit."),
        );
        yield* harness.endTurn(CHILD, undefined, "error");
        yield* settle;
        // Out of quota: the queued message waits.
        assert.isFalse((yield* harness.starts).some((start) => bodyOf(start) === "Task two."));

        yield* Ref.update(harness.errors, () => new Map());
        yield* messaging.configureAgent(LEAD, {
          agent: CHILD,
          providerId: "codex",
          model: "gpt-5.4",
        });
        yield* settle;

        const starts = yield* harness.starts;
        const next = starts.at(-1)!;
        assert.equal(next.threadId, CHILD);
        assert.equal(bodyOf(next), "Task two.");
        assert.equal(next.modelSelection?.model, "gpt-5.4");
        // The thread's own model follows too, for the user's next prompt.
        assert.equal((yield* Ref.get(harness.models)).get(CHILD), "gpt-5.4");
        const accepted = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task three." });
        assert.equal(accepted.delivery, "queued");
      }),
    ),
  );

  it.effect("continueAfterLimit continues the stopped work, then delivers the queued mail", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task one." });
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Task two." });
        yield* Ref.update(harness.errors, (map) =>
          new Map(map).set(CHILD, "You have hit your usage limit."),
        );
        yield* harness.endTurn(CHILD, undefined, "error");
        yield* settle;

        yield* Ref.update(harness.errors, () => new Map());
        assert.equal(
          yield* messaging.continueAfterLimit(CHILD, MessageId.make("resume-1"), "usage"),
          "started",
        );
        yield* settle;
        const resumed = (yield* harness.starts).at(-1)!;
        assert.equal(resumed.threadId, CHILD);
        assert.equal(resumed.message.text, USAGE_RESET_CONTINUE_PROMPT);
        assert.equal(
          USAGE_RESET_CONTINUE_PROMPT,
          "The usage limit has reset. Continue exactly where you left off and finish the task.",
        );

        // A busy thread is left alone.
        assert.equal(
          yield* messaging.continueAfterLimit(CHILD, MessageId.make("resume-2"), "usage"),
          "busy",
        );

        yield* harness.endTurn(CHILD, "Done.");
        yield* settle;
        assert.equal(bodyOf((yield* harness.starts).at(-1)), "Task two.");
      }),
    ),
  );

  describe("reasoning effort", () => {
    it.effect("list_models offers the effort levels and fast mode", () =>
      withMessaging((_harness, messaging) =>
        Effect.gen(function* () {
          const providers = yield* messaging.listModels();
          const model = providers.find((p) => p.providerId === "codex")!.models[0]!;
          assert.deepEqual(
            model.effortLevels?.map((level) => level.id),
            ["low", "medium", "high", "xhigh"],
          );
          assert.equal(model.fastMode, true);
          assert.isUndefined(
            providers.find((p) => p.providerId === "claudeAgent")!.models[0]!.effortLevels,
          );
        }),
      ),
    );

    it.effect("spawn puts effort and fast mode on the child's model selection", () =>
      withMessaging((harness, messaging) =>
        Effect.gen(function* () {
          // The mocked projection has no child thread, so delivery fails after
          // the thread is created; the created selection is what matters.
          yield* messaging
            .spawnAgent(LEAD, {
              name: "Helper",
              prompt: "Go.",
              providerId: "codex",
              effort: "High",
              fastMode: true,
            })
            .pipe(Effect.ignore);
          const created = harness.selections.find((entry) => entry.type === "thread.create")!;
          assert.deepEqual(created.modelSelection, {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          });
        }),
      ),
    );

    it.effect("spawn without effort starts the child at High", () =>
      withMessaging((harness, messaging) =>
        Effect.gen(function* () {
          yield* messaging
            .spawnAgent(LEAD, { name: "Helper", prompt: "Go.", providerId: "codex" })
            .pipe(Effect.ignore);
          const created = harness.selections.find((entry) => entry.type === "thread.create")!;
          assert.deepInclude(created.modelSelection as ModelSelection, {
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "default" },
            ],
          });
        }),
      ),
    );

    it.effect("spawn without effort keeps the default on a model with no effort levels", () =>
      withMessaging((harness, messaging) =>
        Effect.gen(function* () {
          yield* messaging
            .spawnAgent(LEAD, { name: "Helper", prompt: "Go.", providerId: "claudeAgent" })
            .pipe(Effect.ignore);
          const created = harness.selections.find((entry) => entry.type === "thread.create")!;
          const selection = created.modelSelection as ModelSelection;
          assert.equal(selection.instanceId, "claudeAgent");
          assert.isUndefined(selection.options);
        }),
      ),
    );

    it.effect("rejects an invalid effort with the valid levels", () =>
      withMessaging((harness, messaging) =>
        Effect.gen(function* () {
          const error = yield* messaging
            .spawnAgent(LEAD, { name: "Helper", prompt: "Go.", providerId: "codex", effort: "max" })
            .pipe(Effect.flip);
          assert.include(error.message, "low, medium, high, xhigh");
          assert.equal(harness.selections.length, 0);
        }),
      ),
    );

    it.effect("configure changes effort for the next turn without interrupting", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Work." });
          yield* settle;
          yield* messaging.configureAgent(LEAD, {
            agent: CHILD,
            providerId: "codex",
            effort: "xhigh",
          });
          const update = harness.selections.find((entry) => entry.type === "thread.meta.update")!;
          assert.deepEqual(update.modelSelection, {
            instanceId: "codex",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "default" },
            ],
          });
          assert.deepEqual(yield* Ref.get(harness.interrupts), []);
        }),
      ),
    );
  });

  it.effect("queues a message for a busy receiver until its turn ends", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* harness.userPrompt(CHILD, "Refactor the parser.");
        yield* settle;

        const sent = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Next task." });
        assert.equal(sent.delivery, "queued");
        assert.equal((yield* harness.starts).length, 0);

        yield* harness.endTurn(CHILD, "Done.");
        yield* settle;
        const starts = yield* harness.starts;
        assert.equal(starts.length, 1);
        assert.equal(bodyOf(starts[0]), "Next task.");
      }),
    ),
  );

  it.effect("stops a runaway chain of automatic hops", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        // Lead and child keep messaging each other from inside the turns
        // those messages started, so every send is one more hop.
        let sender = LEAD;
        let receiver = CHILD;
        for (let hop = 0; hop < AGENT_MESSAGE_MAX_HOPS; hop += 1) {
          yield* messaging.sendMessage(sender, { to: receiver, message: `ping ${hop}` });
          yield* settle;
          yield* harness.endTurn(sender);
          yield* settle;
          [sender, receiver] = [receiver, sender];
        }
        const blocked = yield* messaging
          .sendMessage(sender, { to: receiver, message: "one more" })
          .pipe(Effect.flip);
        assert.include(blocked.message, `${AGENT_MESSAGE_MAX_HOPS} automatic hops`);
        // Spawning is one more hop too.
        const spawnBlocked = yield* messaging
          .spawnAgent(sender, { name: "Helper", prompt: "Take over." })
          .pipe(Effect.flip);
        assert.include(spawnBlocked.message, `${AGENT_MESSAGE_MAX_HOPS} automatic hops`);
        assert.equal((yield* harness.starts).length, AGENT_MESSAGE_MAX_HOPS);
      }),
    ),
  );

  it.effect("refuses agents outside the caller's tree", () =>
    withMessaging((_harness, messaging) =>
      Effect.gen(function* () {
        const error = yield* messaging
          .sendMessage(LEAD, { to: "stranger", message: "hi" })
          .pipe(Effect.flip);
        assert.include(error.message, "No agent");
      }),
    ),
  );

  describe("stop and resume", () => {
    it.effect("restarting an idle agent's session does not pause it; a Stop does", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          const stopRequested = (restart: boolean) =>
            PubSub.publish(harness.events, {
              type: "thread.session-stop-requested",
              payload: { threadId: CHILD, ...(restart ? { restart: true } : {}) },
            } as unknown as OrchestrationEvent);

          yield* stopRequested(true);
          yield* settle;
          const afterRestart = yield* messaging.listAgents(LEAD);
          assert.notEqual(afterRestart.find((agent) => agent.id === CHILD)?.status, "paused");

          yield* stopRequested(false);
          yield* settle;
          const afterStop = yield* messaging.listAgents(LEAD);
          assert.equal(afterStop.find((agent) => agent.id === CHILD)?.status, "paused");
        }),
      ),
    );

    it.effect("Stop all pauses the tree: the stopped turn's reply and new messages are held", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, {
            to: CHILD,
            message: "Audit the frontend.",
            replyExpected: true,
          });
          yield* settle;
          const stopped = yield* messaging.stop({ threadId: LEAD, scope: "tree" });
          assert.deepEqual([...stopped.threadIds].toSorted(), [CHILD, LEAD].toSorted());
          assert.deepEqual(yield* harness.interrupts.pipe(Ref.get), [CHILD]);
          yield* settle;
          yield* harness.endTurn(CHILD, "Half an audit", "interrupted");
          yield* settle;

          // Nothing restarted, nothing was routed to the paused lead.
          assert.equal((yield* harness.starts).length, 1);
          const sent = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Status?" });
          assert.equal(sent.delivery, "queued");
          assert.include(sent.note ?? "", "stopped by the user");
          const agents = yield* messaging.listAgents(LEAD);
          assert.equal(agents.find((agent) => agent.id === CHILD)?.status, "paused");

          const control = yield* messaging.controlChanges.pipe(Stream.take(1), Stream.runCollect);
          const snapshot: AgentControlSnapshot = [...control][0]!;
          assert.deepEqual(
            snapshot.find((entry) => entry.threadId === CHILD),
            { threadId: CHILD, paused: true, queued: 1 },
          );

          // Resume continues the stopped turn; its answer goes to the lead.
          yield* messaging.resume({ threadId: LEAD, scope: "tree" });
          yield* settle;
          let starts = yield* harness.starts;
          assert.equal(starts.length, 2);
          assert.equal(starts[1]!.threadId, CHILD);
          assert.equal(starts[1]!.message.text, AGENT_CONTINUE_PROMPT);

          yield* harness.endTurn(CHILD, "Frontend: 3 gaps.");
          yield* settle;
          starts = yield* harness.starts;
          const toLead = starts.find((start) => start.threadId === LEAD);
          assert.equal(bodyOf(toLead), "Frontend: 3 gaps.");
          // Then the held "Status?" runs on the child.
          assert.equal(bodyOf(starts.findLast((start) => start.threadId === CHILD)), "Status?");
        }),
      ),
    );

    it.effect(
      "Resume before interruption completes waits, then continues without routing partial output",
      () =>
        withMessaging((harness, messaging, settle) =>
          Effect.gen(function* () {
            yield* messaging.sendMessage(LEAD, {
              to: CHILD,
              message: "Audit.",
              replyExpected: true,
            });
            yield* settle;
            yield* messaging.stop({ threadId: CHILD, scope: "thread" });
            yield* messaging.resume({ threadId: CHILD, scope: "thread" });
            yield* settle;
            assert.equal((yield* harness.starts).length, 1);
            yield* harness.endTurn(CHILD, "Half done", "interrupted");
            yield* settle;
            const resumed = yield* harness.starts;
            assert.equal(resumed.length, 2);
            assert.equal(resumed[1]!.message.text, AGENT_CONTINUE_PROMPT);
            yield* harness.endTurn(CHILD, "All done");
            yield* settle;
            assert.equal(bodyOf((yield* harness.starts)[2]), "All done");
          }),
        ),
    );

    it.effect("Discard before interruption completes suppresses the interrupted reply", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Audit.", replyExpected: true });
          yield* settle;
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* messaging.discard({ threadId: CHILD, scope: "thread" });
          yield* harness.endTurn(CHILD, "Half done", "interrupted");
          yield* settle;
          assert.equal((yield* harness.starts).length, 1);
          assert.equal(
            (yield* messaging.listAgents(LEAD)).find((agent) => agent.id === CHILD)?.status,
            "idle",
          );
        }),
      ),
    );

    it.effect("a second Stop cancels an early Resume", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Audit.", replyExpected: true });
          yield* settle;
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* messaging.resume({ threadId: CHILD, scope: "thread" });
          yield* harness.clientInterrupt(CHILD);
          yield* harness.endTurn(CHILD, "Half done", "interrupted");
          yield* settle;
          assert.equal((yield* harness.starts).length, 1);
          assert.equal(
            (yield* messaging.listAgents(LEAD)).find((agent) => agent.id === CHILD)?.status,
            "paused",
          );
        }),
      ),
    );

    it.effect(
      "a user takeover before interruption completes releases the request without routing partial output",
      () =>
        withMessaging((harness, messaging, settle) =>
          Effect.gen(function* () {
            yield* messaging.sendMessage(LEAD, {
              to: CHILD,
              message: "Audit.",
              replyExpected: true,
            });
            yield* settle;
            yield* messaging.stop({ threadId: CHILD, scope: "thread" });
            yield* settle;
            yield* harness.userPrompt(CHILD, "Do this instead.");
            yield* settle;
            yield* harness.endTurn(CHILD, "Answer to user");
            yield* settle;
            const replies = (yield* harness.starts).filter((start) => start.threadId === LEAD);
            assert.equal(replies.length, 1);
            assert.include(bodyOf(replies[0]) ?? "", "the user is now directing this agent");
          }),
        ),
    );

    it.effect("a newer Stop wins while Resume is preparing the continuation", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Audit.", replyExpected: true });
          yield* settle;
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* harness.endTurn(CHILD, "Half done", "interrupted");
          yield* settle;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          harness.blockNextUuid({ entered, release });
          const resuming = yield* messaging
            .resume({ threadId: CHILD, scope: "thread" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(resuming);
          yield* settle;
          assert.equal((yield* harness.starts).length, 1);
          assert.equal(
            (yield* messaging.listAgents(LEAD)).find((agent) => agent.id === CHILD)?.status,
            "paused",
          );
        }),
      ),
    );

    it.effect("Resume redelivers a held request that the provider never accepted", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          harness.delayedStarts.add(CHILD);
          yield* messaging.sendMessage(LEAD, {
            to: CHILD,
            message: "Audit the parser.",
            replyExpected: true,
          });
          const request = (yield* harness.starts)[0]!;
          yield* settle;
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* harness.rejectTurn(CHILD, request.message.messageId, "Connection closed");
          yield* settle;
          harness.delayedStarts.delete(CHILD);
          yield* messaging.resume({ threadId: CHILD, scope: "thread" });
          yield* settle;
          assert.equal(bodyOf((yield* harness.starts)[1]), "Audit the parser.");
        }),
      ),
    );

    it.effect(
      "Stop during the send window interrupts the turn once it binds and Resume delivers a completed answer",
      () =>
        withMessaging((harness, messaging, settle) =>
          Effect.gen(function* () {
            harness.delayedStarts.add(CHILD);
            yield* messaging.sendMessage(LEAD, {
              to: CHILD,
              message: "Audit the parser.",
              replyExpected: true,
            });
            const request = (yield* harness.starts)[0]!;
            yield* messaging.stop({ threadId: CHILD, scope: "thread" });
            const turnId = yield* harness.runTurn(
              CHILD,
              request.message.messageId,
              request.message.text,
            );
            yield* settle;
            const before = (yield* Ref.get(harness.interrupts)).length;
            yield* harness.acceptTurn(CHILD, request.message.messageId, turnId);
            yield* settle;
            assert.equal((yield* Ref.get(harness.interrupts)).length, before + 1);

            // The turn finished normally despite the stop: its answer is held.
            yield* harness.endTurn(CHILD, "The full audit");
            yield* settle;
            assert.equal((yield* harness.starts).length, 1);

            yield* messaging.resume({ threadId: CHILD, scope: "thread" });
            yield* settle;
            const starts = yield* harness.starts;
            assert.equal(starts.length, 2);
            assert.equal(starts[1]!.threadId, LEAD);
            assert.equal(bodyOf(starts[1]), "The full audit");
            assert.isFalse(starts.some((start) => start.message.text === AGENT_CONTINUE_PROMPT));
          }),
        ),
    );

    it.effect("a user Stop pauses a child agent until the user prompts it", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* harness.userPrompt(CHILD, "Work on the parser.");
          yield* settle;
          // The composer's Stop button: a plain turn interrupt from the client.
          yield* harness.clientInterrupt(CHILD);
          yield* settle;
          yield* harness.endTurn(CHILD, undefined, "interrupted");
          yield* settle;

          const sent = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Next." });
          assert.equal(sent.delivery, "queued");
          yield* settle;
          assert.equal((yield* harness.starts).length, 0);

          // Typing into it resumes it; the held message runs after that turn.
          yield* harness.userPrompt(CHILD, "Carry on.");
          yield* settle;
          yield* harness.endTurn(CHILD, "Parser done.");
          yield* settle;
          assert.equal(bodyOf((yield* harness.starts)[0]), "Next.");
        }),
      ),
    );

    it.effect("Discard drops held work without waking the agent", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* messaging.stop({ threadId: CHILD, scope: "thread" });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "One." });
          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Two." });
          const discarded = yield* messaging.discard({ threadId: CHILD, scope: "thread" });
          assert.deepEqual(discarded.threadIds, [CHILD]);
          yield* settle;
          assert.equal((yield* harness.starts).length, 0);
          const agents = yield* messaging.listAgents(LEAD);
          const child = agents.find((agent) => agent.id === CHILD);
          assert.equal(child?.status, "idle");
          assert.equal(child?.queuedMessages, 0);
        }),
      ),
    );

    it.effect("stopping a thread outside any agent tree pauses nothing", () =>
      withMessaging((harness, messaging, settle) =>
        Effect.gen(function* () {
          yield* harness.userPrompt(LONER, "Hello.");
          yield* settle;
          const result = yield* messaging.stop({ threadId: LONER, scope: "tree" });
          assert.deepEqual(result.threadIds, [LONER]);
          yield* settle;
          const control = yield* messaging.controlChanges.pipe(Stream.take(1), Stream.runCollect);
          assert.deepEqual([...control][0], []);
        }),
      ),
    );
  });
});

describe("isLimitError", () => {
  it("recognises usage, plan and credit limits", () => {
    for (const message of [
      "Claude usage limit reached. Try again at 5pm.",
      "usage_limit_reached",
      "You exceeded your current quota, please check your plan and billing details.",
      "403 MODEL_NOT_IN_PLAN",
      "This model is not available on your plan",
      "You have run out of credits",
      "Insufficient balance",
      "You've hit your limit · resets 8pm (UTC)",
      "5-hour limit reached ∙ resets 3pm",
    ]) {
      assert.isTrue(isLimitError(message), message);
    }
  });

  it("does not treat context-length or other failures as a quota problem", () => {
    for (const message of [
      "Context window exceeded",
      "Context limit reached",
      "context_length_exceeded: this model's maximum context length is 200000 tokens",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "Request exceeded max_tokens",
      "Timeout exceeded while waiting for the provider",
      "Command exited with code 1",
      // A throttle is retried (UsageResume), not treated as out of usage.
      "Rate limit exceeded, retry after 30s",
      "429 Too Many Requests",
      "Failed to read file with 429 lines",
      null,
      undefined,
    ]) {
      assert.isFalse(isLimitError(message), String(message));
    }
  });
});
