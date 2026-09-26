import {
  type AgentControlSnapshot,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { parseAgentMessage } from "@t3tools/shared/agentMessages";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  AGENT_CONTINUE_PROMPT,
  AGENT_MESSAGE_MAX_HOPS,
  AgentMessaging,
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

  const dispatch = (command: OrchestrationCommand) => {
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
  ) =>
    ({
      id,
      projectId: "project",
      title: id === LEAD ? "Lead" : id === CHILD ? "Child" : "Loner",
      modelSelection: { instanceId: "claudeAgent", model: model ?? "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      parentThreadId,
      latestTurn: null,
      session: turnId
        ? {
            threadId: id,
            status: "running",
            activeTurnId: turnId,
            providerInstanceId: "claudeAgent",
            lastError: null,
          }
        : {
            threadId: id,
            status: lastError ? "error" : "ready",
            activeTurnId: null,
            providerInstanceId: "claudeAgent",
            lastError: lastError ?? null,
          },
    }) as unknown as OrchestrationThreadShell;

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.all([Ref.get(activeTurn), Ref.get(errors), Ref.get(models)]).pipe(
          Effect.map(([turns, failed, chosen]) => ({
            snapshotSequence: 1,
            projects: [],
            threads: [
              shell(LEAD, null, turns.get(LEAD), failed.get(LEAD), chosen.get(LEAD)),
              shell(CHILD, LEAD, turns.get(CHILD), failed.get(CHILD), chosen.get(CHILD)),
              shell(LONER, null, turns.get(LONER), failed.get(LONER), chosen.get(LONER)),
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
      getProviders: Effect.succeed([
        {
          instanceId: "claudeAgent",
          models: [{ slug: "claude-sonnet-4-6", name: "Sonnet" }],
        },
        {
          instanceId: "codex",
          models: [{ slug: "gpt-5.4", name: "GPT-5.4", isDefault: true }],
        },
      ] as never),
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
    interrupts,
    starts,
    endTurn,
    userPrompt,
    clientInterrupt,
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

  it.effect("tells the sender when a receiver runs out of quota and refuses further messages", () =>
    withMessaging((harness, messaging, settle) =>
      Effect.gen(function* () {
        yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Run the Python suite." });
        yield* Ref.update(harness.errors, (map) =>
          new Map(map).set(
            CHILD,
            "Claude usage limit reached. Send the message again once the limit resets.",
          ),
        );
        yield* harness.endTurn(CHILD, undefined, "error");
        yield* settle;

        const starts = yield* harness.starts;
        assert.equal(starts.length, 2);
        assert.equal(starts[1]!.threadId, LEAD);
        assert.include(bodyOf(starts[1]) ?? "", "Do not message it again");

        const refused = yield* messaging
          .sendMessage(LEAD, { to: CHILD, message: "Are you still going?" })
          .pipe(Effect.flip);
        assert.include(refused.message, "out of quota");
        assert.equal((yield* harness.starts).length, 2);
      }),
    ),
  );

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
  it("recognises usage, rate, plan and credit limits", () => {
    for (const message of [
      "Claude usage limit reached. Try again at 5pm.",
      "usage_limit_reached",
      "Rate limit exceeded, retry after 30s",
      "429 Too Many Requests",
      "You exceeded your current quota, please check your plan and billing details.",
      "403 MODEL_NOT_IN_PLAN",
      "This model is not available on your plan",
      "You have run out of credits",
      "Insufficient balance",
    ]) {
      assert.isTrue(isLimitError(message), message);
    }
  });

  it("does not treat context-length or other failures as a quota problem", () => {
    for (const message of [
      "Context window exceeded",
      "context_length_exceeded: this model's maximum context length is 200000 tokens",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "Request exceeded max_tokens",
      "Timeout exceeded while waiting for the provider",
      "Command exited with code 1",
      null,
      undefined,
    ]) {
      assert.isFalse(isLimitError(message), String(message));
    }
  });
});
