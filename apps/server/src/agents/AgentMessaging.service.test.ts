import {
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerActivation } from "../serverActivation.ts";
import { AGENT_MESSAGE_MAX_HOPS, AgentMessaging, layer } from "./AgentMessaging.ts";

type TurnStart = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

const LEAD = ThreadId.make("lead");
const CHILD = ThreadId.make("child");

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

function shell(id: ThreadId, parentThreadId: ThreadId | null, busy = false, lastError?: string) {
  return {
    id,
    projectId: "project",
    title: id === LEAD ? "Lead" : "Child",
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    parentThreadId,
    latestTurn: null,
    session: busy
      ? { threadId: id, status: "running", providerInstanceId: "claudeAgent", lastError: null }
      : {
          threadId: id,
          status: lastError ? "error" : "ready",
          providerInstanceId: "claudeAgent",
          lastError: lastError ?? null,
        },
  } as unknown as OrchestrationThreadShell;
}

const makeHarness = Effect.gen(function* () {
  const busy = yield* Ref.make(new Set<string>());
  const answers = yield* Ref.make(new Map<string, string>());
  const errors = yield* Ref.make(new Map<string, string>());
  const turnStarts = yield* Ref.make<ReadonlyArray<TurnStart>>([]);
  const events = yield* PubSub.unbounded<OrchestrationEvent>();

  const dispatch = (command: OrchestrationCommand) =>
    command.type === "thread.turn.start"
      ? Ref.update(turnStarts, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 }))
      : Effect.succeed({ sequence: 1 });

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.all([Ref.get(busy), Ref.get(errors)]).pipe(
          Effect.map(([set, failed]) => ({
            snapshotSequence: 1,
            projects: [],
            threads: [
              shell(LEAD, null, set.has(LEAD), failed.get(LEAD)),
              shell(CHILD, LEAD, set.has(CHILD), failed.get(CHILD)),
            ],
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
        ),
      getThreadDetailById: (threadId) =>
        Ref.get(answers).pipe(
          Effect.map((map) =>
            Option.some({
              messages: map.has(threadId)
                ? [
                    {
                      role: "assistant",
                      text: map.get(threadId),
                      streaming: false,
                      createdAt: "2099-01-01T00:00:00.000Z",
                    },
                  ]
                : [],
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
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.succeed(ServerActivation, undefined),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  /** The receiver's session left "running": its turn ended. */
  const endTurn = (threadId: ThreadId) =>
    Ref.update(busy, (set) => {
      const next = new Set(set);
      next.delete(threadId);
      return next;
    }).pipe(
      Effect.andThen(
        PubSub.publish(events, {
          type: "thread.session-set",
          payload: { threadId, session: { threadId, status: "ready" } },
        } as unknown as OrchestrationEvent),
      ),
    );

  return {
    busy,
    answers,
    errors,
    turnStarts,
    endTurn,
    layer: layer.pipe(Layer.provide(dependencies)),
  };
});

describe("AgentMessaging", () => {
  it.effect("wakes an idle receiver and routes its final answer back to the sender", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          yield* messaging.start();

          const sent = yield* messaging.sendMessage(LEAD, {
            to: "Child",
            message: "Audit the frontend.",
            replyExpected: true,
          });
          assert.equal(sent.delivery, "started");
          const [wake] = yield* Ref.get(harness.turnStarts);
          assert.equal(wake?.threadId, CHILD);
          const envelope = parseAgentMessage(wake?.message.text ?? "");
          assert.equal(envelope?.fromThreadId, LEAD);
          assert.isTrue(envelope?.replyExpected);

          yield* Ref.update(harness.answers, (map) => new Map(map).set(CHILD, "3 gaps found."));
          yield* harness.endTurn(CHILD);
          yield* Effect.yieldNow;
          yield* messaging.drain;

          const starts = yield* Ref.get(harness.turnStarts);
          assert.equal(starts.length, 2);
          const reply = parseAgentMessage(starts[1]!.message.text);
          assert.equal(starts[1]!.threadId, LEAD);
          assert.equal(reply?.body, "3 gaps found.");
          assert.equal(reply?.inReplyTo, sent.messageId);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("reports the receiver's error when its turn fails without an answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          yield* messaging.start();

          yield* messaging.sendMessage(LEAD, {
            to: CHILD,
            message: "Run the tests.",
            replyExpected: true,
          });
          yield* Ref.update(harness.errors, (map) =>
            new Map(map).set(CHILD, "403 MODEL_NOT_IN_PLAN"),
          );
          yield* harness.endTurn(CHILD);
          yield* Effect.yieldNow;
          yield* messaging.drain;

          const starts = yield* Ref.get(harness.turnStarts);
          assert.equal(starts.length, 2);
          assert.include(
            parseAgentMessage(starts[1]!.message.text)?.body ?? "",
            "403 MODEL_NOT_IN_PLAN",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("tells the sender when a receiver runs out of quota and refuses further messages", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          yield* messaging.start();

          yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Run the Python suite." });
          yield* Ref.update(harness.errors, (map) =>
            new Map(map).set(
              CHILD,
              "Claude usage limit reached. Send the message again once the limit resets.",
            ),
          );
          yield* harness.endTurn(CHILD);
          yield* Effect.yieldNow;
          yield* messaging.drain;

          const starts = yield* Ref.get(harness.turnStarts);
          assert.equal(starts.length, 2);
          assert.equal(starts[1]!.threadId, LEAD);
          assert.include(
            parseAgentMessage(starts[1]!.message.text)?.body ?? "",
            "Do not message it again",
          );

          const refused = yield* messaging
            .sendMessage(LEAD, { to: CHILD, message: "Are you still going?" })
            .pipe(Effect.flip);
          assert.include(refused.message, "out of quota");
          assert.equal((yield* Ref.get(harness.turnStarts)).length, 2);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("queues a message for a busy receiver until its turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.busy, new Set([CHILD]));
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          yield* messaging.start();

          const sent = yield* messaging.sendMessage(LEAD, { to: CHILD, message: "Next task." });
          assert.equal(sent.delivery, "queued");
          assert.equal((yield* Ref.get(harness.turnStarts)).length, 0);

          yield* harness.endTurn(CHILD);
          yield* Effect.yieldNow;
          yield* messaging.drain;
          const starts = yield* Ref.get(harness.turnStarts);
          assert.equal(starts.length, 1);
          assert.equal(parseAgentMessage(starts[0]!.message.text)?.body, "Next task.");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("stops a runaway chain of automatic hops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          yield* messaging.start();

          // Lead and child keep messaging each other from inside the turns
          // those messages started, so every send is one more hop.
          let sender = LEAD;
          let receiver = CHILD;
          for (let hop = 0; hop < AGENT_MESSAGE_MAX_HOPS; hop += 1) {
            yield* messaging.sendMessage(sender, { to: receiver, message: `ping ${hop}` });
            yield* harness.endTurn(sender);
            yield* Effect.yieldNow;
            yield* messaging.drain;
            [sender, receiver] = [receiver, sender];
          }
          const blocked = yield* messaging
            .sendMessage(sender, { to: receiver, message: "one more" })
            .pipe(Effect.flip);
          assert.include(blocked.message, `${AGENT_MESSAGE_MAX_HOPS} automatic hops`);
          assert.equal((yield* Ref.get(harness.turnStarts)).length, AGENT_MESSAGE_MAX_HOPS);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect("refuses agents outside the caller's tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging;
          const error = yield* messaging
            .sendMessage(LEAD, { to: "stranger", message: "hi" })
            .pipe(Effect.flip);
          assert.include(error.message, "No agent");
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );
});
