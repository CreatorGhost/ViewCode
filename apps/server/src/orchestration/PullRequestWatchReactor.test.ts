import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProjectId,
  type PullRequestActivity,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  PullRequestOperationError,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { AgentMessaging } from "../agents/AgentMessaging.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  PULL_REQUEST_WATCH_READ_FAILURE_LIMIT,
  PULL_REQUEST_WATCH_SWEEP_MINUTES,
  PullRequestWatchReactor,
  layer,
} from "./PullRequestWatchReactor.ts";
import { decidePullRequestWatch, freshPullRequestWatch } from "./pullRequestWatch.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const THREAD = ThreadId.make("thread-1");
const START = "1970-01-01T00:00:00.000Z";

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

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});

const watchedLink = (): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  source: "agent",
  linkedAt: START,
  snapshot: null,
  stack: null,
  watch: freshPullRequestWatch(START),
});

type WakeOutcome = "started" | "busy" | "held" | "gone";
type Session = "ready" | "running";

const makeHarness = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  const thread = yield* Ref.make({
    links: [watchedLink()] as ReadonlyArray<ThreadPullRequestLink>,
    session: "ready" as Session,
    settledAt: null as string | null,
  });
  const detail = yield* Ref.make({
    state: "open" as PullRequestDetail["state"],
    headSha: "aaaaaaa1",
    checks: [check("test", "pending")] as ReadonlyArray<PullRequestCheck>,
    mergeability: "mergeable" as PullRequestDetail["mergeability"],
  });
  const comments = yield* Ref.make<ReadonlyArray<PullRequestComment>>([]);
  const readFails = yield* Ref.make(false);
  const reads = yield* Ref.make(0);
  const outcome = yield* Ref.make<WakeOutcome>("started");
  /** Every wake the agent was offered, with what it answered. */
  const wakes = yield* Queue.unbounded<{ text: string; outcome: WakeOutcome }>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

  const shell = Ref.get(thread).pipe(
    Effect.map(
      (state) =>
        ({
          id: THREAD,
          projectId: ProjectId.make("project-1"),
          pullRequests: state.links,
          archivedAt: null,
          settledOverride: null,
          settledAt: state.settledAt,
          session: { status: state.session },
        }) as unknown as OrchestrationThreadShell,
    ),
  );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        shell.pipe(
          Effect.map((current) => ({
            snapshotSequence: 1,
            projects: [],
            threads: [current],
            updatedAt: START,
          })),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      // Applies watch passes the way the decider does, so the next pass sees what was recorded.
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Ref.update(commands, (all) => [...all, command]);
          if (command.type !== "thread.pull-request-watch.sync") return { sequence: 1 };
          const state = yield* Ref.get(thread);
          const decided = decidePullRequestWatch(
            {
              pullRequests: state.links,
              archivedAt: null,
              settledOverride: null,
              settledAt: state.settledAt,
            },
            command,
            START,
          );
          if ("link" in decided) yield* Ref.set(thread, { ...state, links: [decided.link] });
          return { sequence: 1 };
        }),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(PullRequestService)({
      detail: () =>
        Effect.gen(function* () {
          yield* Ref.update(reads, (count) => count + 1);
          if (yield* Ref.get(readFails)) {
            return yield* new PullRequestOperationError({
              operation: "detail",
              detail: "host unreachable",
            });
          }
          const current = yield* Ref.get(detail);
          return {
            ...current,
            baseBranch: "main",
            viewer: "agent-bot",
            author: null,
          } as unknown as PullRequestDetail;
        }),
      activity: () =>
        Ref.get(comments).pipe(
          Effect.map(
            (all) =>
              ({
                comments: all,
                commentCount: all.length,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }) as unknown as PullRequestActivity,
          ),
        ),
    }),
    Layer.mock(AgentMessaging)({
      wake: (_threadId, _messageId, text) =>
        Ref.get(outcome).pipe(
          Effect.tap((answer) => Queue.offer(wakes, { text, outcome: answer })),
        ),
    }),
    Layer.succeed(ServerActivation, undefined),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  const reactor = yield* PullRequestWatchReactor.pipe(
    Effect.provide(layer.pipe(Layer.provide(dependencies))),
  );
  const watch = Ref.get(thread).pipe(Effect.map((state) => state.links[0]?.watch));
  const nextWake = Queue.take(wakes);
  const pendingWakes = Queue.size(wakes);
  return {
    reactor,
    thread,
    detail,
    comments,
    readFails,
    reads,
    outcome,
    commands,
    watch,
    nextWake,
    pendingWakes,
    publish: (event: unknown) => PubSub.publish(events, event as OrchestrationEvent),
    dependencies,
  };
});

describe("PullRequestWatchReactor", () => {
  it.effect("wakes once per change and records what the agent was told", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // The first pass learns the head; a pending check is no news.
      yield* harness.reactor.sweep;
      assert.equal(yield* harness.pendingWakes, 0);
      assert.equal((yield* harness.watch)?.headSha, "aaaaaaa1");

      yield* Ref.update(harness.detail, (current) => ({
        ...current,
        checks: [check("test", "failure")],
      }));
      yield* TestClock.adjust(`${PULL_REQUEST_WATCH_SWEEP_MINUTES} minutes`);
      yield* harness.reactor.sweep;
      const wake = yield* harness.nextWake;
      assert.include(wake.text, "- Checks failed on aaaaaaa:");
      assert.deepEqual((yield* harness.watch)?.failedChecks, ["test"]);

      // Told already: another pass over the same state stays quiet.
      yield* TestClock.adjust(`${PULL_REQUEST_WATCH_SWEEP_MINUTES} minutes`);
      yield* harness.reactor.sweep;
      assert.equal(yield* harness.pendingWakes, 0);
    }),
  );

  it.effect("holds a wake while the thread is busy and delivers it when the turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.update(harness.detail, (current) => ({
          ...current,
          checks: [check("test", "success")],
        }));
        yield* Ref.set(harness.outcome, "busy");
        yield* Ref.update(harness.thread, (state) => ({ ...state, session: "running" as const }));
        yield* harness.reactor.start();
        yield* harness.reactor.sweep;
        assert.equal((yield* harness.nextWake).outcome, "busy");
        // Not told yet, so nothing is recorded and a restart would report it again.
        assert.equal((yield* harness.watch)?.passed, false);

        yield* Ref.set(harness.outcome, "started");
        yield* Ref.update(harness.thread, (state) => ({ ...state, session: "ready" as const }));
        yield* harness.publish({
          type: "thread.session-set",
          payload: { threadId: THREAD, session: { status: "ready" } },
        });
        let wake = yield* harness.nextWake;
        // The start-up pass may have offered the wake too while the thread was busy.
        while (wake.outcome !== "started") wake = yield* harness.nextWake;
        assert.include(wake.text, "- All 1 check passed on aaaaaaa.");
        yield* harness.reactor.drain;
        assert.equal((yield* harness.watch)?.passed, true);
        // Recorded once told, so a later full read finds nothing new to say.
        yield* TestClock.adjust("10 minutes");
        yield* harness.reactor.sweep;
        assert.equal(yield* harness.pendingWakes, 0);
      }),
    ),
  );

  it.effect("ends the watch when the pull request merges, without waking the agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.update(harness.detail, (current) => ({ ...current, state: "merged" as const }));
      yield* harness.reactor.sweep;
      assert.equal(yield* harness.watch, undefined);
      assert.equal(yield* harness.pendingWakes, 0);
    }),
  );

  it.effect("ends the watch when the pull request closes, and says so", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.update(harness.detail, (current) => ({ ...current, state: "closed" as const }));
      yield* harness.reactor.sweep;
      assert.equal(yield* harness.watch, undefined);
      assert.include((yield* harness.nextWake).text, "was closed, so ViewCode stopped watching");
    }),
  );

  it.effect("ends a settled thread's watch without reading the host", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.update(harness.thread, (state) => ({ ...state, settledAt: START }));
      yield* harness.reactor.sweep;
      assert.equal(yield* harness.watch, undefined);
      assert.equal(yield* Ref.get(harness.reads), 0);
    }),
  );

  it.effect("skips reads while nothing moved, and reads again after the quiet interval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.update(harness.detail, (current) => ({
        ...current,
        checks: [check("test", "success")],
      }));
      yield* harness.reactor.sweep;
      yield* harness.nextWake;
      assert.equal(yield* Ref.get(harness.reads), 1);
      yield* TestClock.adjust(`${PULL_REQUEST_WATCH_SWEEP_MINUTES} minutes`);
      yield* harness.reactor.sweep;
      assert.equal(yield* Ref.get(harness.reads), 1);
      yield* TestClock.adjust("10 minutes");
      yield* harness.reactor.sweep;
      assert.equal(yield* Ref.get(harness.reads), 2);
    }),
  );

  it.effect("backs off failed reads and gives up after the limit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.readFails, true);
      let passes = 0;
      while ((yield* harness.watch) !== undefined && passes < 100) {
        yield* harness.reactor.sweep;
        yield* TestClock.adjust(`${PULL_REQUEST_WATCH_SWEEP_MINUTES} minutes`);
        passes += 1;
      }
      assert.equal(yield* Ref.get(harness.reads), PULL_REQUEST_WATCH_READ_FAILURE_LIMIT);
      // Backoff: more passes than reads.
      assert.isAbove(passes, PULL_REQUEST_WATCH_READ_FAILURE_LIMIT);
      assert.include((yield* harness.nextWake).text, "failed to read it from the host 8 times");
    }),
  );
});
