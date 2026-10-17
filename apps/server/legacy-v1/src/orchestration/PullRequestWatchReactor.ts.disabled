import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PullRequestActivity,
  type PullRequestComment,
  type ThreadId,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { AgentMessaging } from "../agents/AgentMessaging.ts";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  evaluatePullRequestWatch,
  pullRequestWatchesEqual,
  pullRequestWatchMessage,
  type PullRequestWatchReport,
} from "./pullRequestWatch.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Minutes between passes. Checks take minutes, so a faster pass mostly spends the host's rate
 * limit, which every machine on the same account shares.
 */
export const PULL_REQUEST_WATCH_SWEEP_MINUTES = 2;
const SWEEP_MS = PULL_REQUEST_WATCH_SWEEP_MINUTES * 60_000;
/** Failed reads in a row (rate limits aside) before the watch ends. */
export const PULL_REQUEST_WATCH_READ_FAILURE_LIMIT = 8;
/** After a failed read, a pull request waits this many passes at most before the next try. */
const MAX_BACKOFF_PASSES = 4;
/**
 * A pull request with nothing in flight whose sync snapshot has not moved is read again only
 * after this long, for news the snapshot cannot show, such as a new review comment.
 */
export const PULL_REQUEST_WATCH_QUIET_REREAD_MS = 10 * 60_000;

const isProviderError = Schema.is(PullRequestProviderError);

/** A rate limit is the host asking us to wait, not a sign the pull request cannot be read. */
const isRateLimited = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      error._tag === "PullRequestOperationError" &&
      isProviderError(error.cause) &&
      error.cause.reason === "rate-limited",
  });

/** What a failure says, without the cause chain: host CLI output never reaches the log. */
const failureDetail = <E>(cause: Cause.Cause<E>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => (Cause.hasDies(cause) ? "defect" : "failed"),
    onSome: (error) =>
      typeof error === "object" && error !== null && "detail" in error
        ? String(error.detail)
        : typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag)
          : "failed",
  });

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, detail: failureDetail(cause) });

interface WatchTarget {
  readonly thread: OrchestrationThreadShell;
  readonly link: ThreadPullRequestLink;
  readonly watch: ThreadPullRequestWatch;
}

/** Every thread of one project that watches one pull request, read once per pass. */
interface WatchGroup {
  readonly key: string;
  readonly targets: ReadonlyArray<WatchTarget>;
  /** What sync last saw of the pull request, to skip a read when nothing moved. */
  readonly fingerprint: string;
}

interface LastRead {
  readonly at: number;
  readonly fingerprint: string;
  /** A check was still running or mergeability unknown, so the detail can move unannounced. */
  readonly inFlight: boolean;
  /** The conversation was read whole; an incomplete one is read again. */
  readonly remarksComplete: boolean;
  /** The watches this read evaluated; a watch started since takes its first look next pass. */
  readonly watches: ReadonlySet<string>;
}

/** A wake the agent has not had yet because its thread was busy, paused or out of usage. */
interface PendingWake {
  readonly target: WatchTarget;
  readonly report: PullRequestWatchReport;
  readonly text: string;
}

/**
 * Why a watch ended. `stopped` is anything outside this reactor: the agent unwatched, the user
 * pressed Stop, the link was removed, or the thread was deleted between passes.
 */
type WatchEndReason =
  | "merged"
  | "closed"
  | "unreadable"
  | "comment-limit"
  | "settled"
  | "archived"
  | "stopped";

/**
 * What one watch did while this server ran, logged once when it ends so we can see how long
 * watches stay quiet. Kept in memory: a watch older than the server process only has partial
 * numbers, and one that ends while the server is down is not logged.
 */
interface WatchLife {
  readonly threadId: string;
  readonly pullRequest: string;
  readonly startedAt: number;
  readonly headSha: string | null;
  /** When a pass last saw the head commit move, or the start. */
  readonly pushedAt: number;
  /** Longest time between pushes, not counting the time since the last one. */
  readonly longestQuietMs: number;
  readonly wakes: number;
  readonly reads: number;
}

const watchId = ({ thread, link, watch }: WatchTarget) =>
  `${thread.id} ${threadPullRequestKeyOf(link)} ${watch.startedAt}`;

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

const snapshotFingerprint = ({ link }: WatchTarget) => {
  const snapshot = link.snapshot;
  return snapshot === null
    ? ""
    : [
        snapshot.state,
        snapshot.updatedAt,
        snapshot.checksState,
        snapshot.mergeability,
        snapshot.reviewDecision,
        snapshot.isDraft,
      ].join(" ");
};

const isLive = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "running" || thread.session?.status === "starting";

/** Whether a pass reads the pull request: a new watch, news, something in flight, or time. */
export function shouldReadPullRequest(
  group: Pick<WatchGroup, "fingerprint"> & { readonly watchIds: ReadonlyArray<string> },
  last: LastRead | undefined,
  now: number,
): boolean {
  if (last === undefined || group.watchIds.some((id) => !last.watches.has(id))) return true;
  return (
    last.inFlight ||
    !last.remarksComplete ||
    last.fingerprint !== group.fingerprint ||
    now - last.at >= PULL_REQUEST_WATCH_QUIET_REREAD_MS
  );
}

/**
 * Remarks from the activity, or null when it was cut short: GitHub's review thread query
 * failed, so review comments may be missing. Replies past the first page of a long review
 * thread are not read.
 */
function remarksOf(activity: PullRequestActivity): ReadonlyArray<PullRequestComment> | null {
  const degraded =
    activity.commentsTruncated &&
    !activity.reviewThreads.some((reviewThread) => reviewThread.nextCommentsCursor !== undefined);
  return degraded ? null : activity.comments;
}

/**
 * Wakes a thread's agent when a pull request it watches (`watch_pull_request`) needs a look:
 * checks finished on the head commit, someone else commented, or the branch started to
 * conflict. A pass every two minutes reads each watched pull request once for all the threads
 * of a project that watch it, and skips the read when the sync snapshot has not moved and
 * nothing is in flight. A failed read backs off; eight in a row end the watch.
 *
 * The wake is a turn started through AgentMessaging, only when the thread is free. A busy,
 * paused or out-of-usage thread keeps the wake pending and gets it when its turn ends; the
 * watch records "told" only once a wake started, so a restart reports the news again.
 * Settling or archiving a thread, or the pull request merging or closing, ends the watch.
 */
export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every watched pull request. */
    readonly sweep: Effect.Effect<void>;
    /** Waits for wakes queued by turn ends to be handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/PullRequestWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const messaging = yield* AgentMessaging;
  const crypto = yield* Crypto.Crypto;
  const bootedAt = yield* Clock.currentTimeMillis;

  const lives = new Map<string, WatchLife>();
  const readFailures = new Map<string, { readonly count: number; readonly retryAt: number }>();
  const lastReads = new Map<string, LastRead>();
  const pending = new Map<string, PendingWake>();
  // A pass and a turn-end wake never run at once, so neither evaluates a watch the other moved.
  const serial = yield* Semaphore.make(1);

  const lifeOf = (target: WatchTarget): WatchLife => {
    const existing = lives.get(watchId(target));
    if (existing !== undefined) return existing;
    const startedAt = Date.parse(target.watch.startedAt);
    const life: WatchLife = {
      threadId: target.thread.id,
      pullRequest: threadPullRequestKeyOf(target.link),
      startedAt,
      headSha: target.watch.headSha,
      pushedAt: startedAt,
      longestQuietMs: 0,
      wakes: 0,
      reads: 0,
    };
    lives.set(watchId(target), life);
    return life;
  };

  const reportEnd = (id: string, life: WatchLife, reason: WatchEndReason) =>
    Effect.gen(function* () {
      lives.delete(id);
      pending.delete(id);
      const now = yield* Clock.currentTimeMillis;
      const quietMs = now - life.pushedAt;
      yield* Effect.logInfo("pull request watch ended", {
        threadId: life.threadId,
        pullRequest: life.pullRequest,
        reason,
        minutes: minutes(now - life.startedAt),
        quietMinutes: minutes(quietMs),
        longestQuietMinutes: minutes(Math.max(life.longestQuietMs, quietMs)),
        wakes: life.wakes,
        reads: life.reads,
        partial: life.startedAt < bootedAt,
      });
    });
  const ended = (target: WatchTarget, reason: WatchEndReason) =>
    Effect.suspend(() => reportEnd(watchId(target), lifeOf(target), reason));

  /**
   * Records what a pass saw. The decider applies it only while the same watch is on, so a stop
   * or restart that lands during the host read wins.
   */
  const record = (target: WatchTarget, next: ThreadPullRequestWatch | null) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
        threadId: target.thread.id,
        host: normalizeThreadPullRequestKey(target.link).host,
        repository: target.link.repository,
        number: target.link.number,
        startedAt: target.watch.startedAt,
        watch: next,
      });
    });

  /** Wakes the agent when its thread is free; otherwise the wake waits for the turn to end. */
  const deliver = Effect.fn("PullRequestWatchReactor.deliver")(function* (
    target: WatchTarget,
    report: PullRequestWatchReport,
    text: string,
  ) {
    const id = watchId(target);
    const uuid = yield* crypto.randomUUIDv4;
    const outcome = yield* messaging.wake(
      target.thread.id,
      MessageId.make(`message:pr-watch:${uuid}`),
      text,
    );
    if (outcome === "busy" || outcome === "held") {
      pending.set(id, { target, report, text });
      return;
    }
    pending.delete(id);
    if (outcome === "gone") {
      yield* record(target, null);
      return yield* ended(target, "archived");
    }
    const life = lifeOf(target);
    lives.set(id, { ...life, wakes: life.wakes + 1 });
    yield* record(target, report.exhausted ? null : report.next);
    if (report.exhausted) yield* ended(target, "comment-limit");
  });

  /** A wake that only says the watch ended; the watch is gone whether or not the agent hears. */
  const endWithWake = (target: WatchTarget, reason: WatchEndReason, text: string) =>
    Effect.gen(function* () {
      yield* record(target, null);
      const uuid = yield* crypto.randomUUIDv4;
      // A busy thread does not get this one later: the watch is already gone.
      yield* messaging
        .wake(target.thread.id, MessageId.make(`message:pr-watch:${uuid}`), text)
        .pipe(Effect.ignore);
      yield* ended(target, reason);
    });

  const giveUp = (target: WatchTarget) =>
    endWithWake(
      target,
      "unreadable",
      `ViewCode stopped watching pull request #${target.link.number} (${target.link.url}) because it failed to read it from the host ${PULL_REQUEST_WATCH_READ_FAILURE_LIMIT} times in a row. Check it yourself, and call watch_pull_request to watch it again.`,
    );

  const closed = (target: WatchTarget) =>
    endWithWake(
      target,
      "closed",
      `Pull request #${target.link.number} (${target.link.url}) was closed, so ViewCode stopped watching it. Call watch_pull_request if it reopens.`,
    );

  /** Runs one thread's step for each thread in a group, so one refusal does not skip the rest. */
  const eachTarget = <E>(
    group: WatchGroup,
    step: (target: WatchTarget) => Effect.Effect<void, E>,
  ) =>
    Effect.forEach(
      group.targets,
      (target) =>
        step(target).pipe(
          Effect.catchCause(
            logFailure("pull request watch update failed", {
              threadId: target.thread.id,
              pullRequest: group.key,
            }),
          ),
        ),
      { discard: true },
    );

  const readGroup = Effect.fn("PullRequestWatchReactor.readGroup")(function* (group: WatchGroup) {
    const now = yield* Clock.currentTimeMillis;
    const failure = readFailures.get(group.key);
    if (failure !== undefined && now < failure.retryAt) return;
    const last = lastReads.get(group.key);
    const watchIds = group.targets.map(watchId);
    if (!shouldReadPullRequest({ fingerprint: group.fingerprint, watchIds }, last, now)) return;

    const first = group.targets[0]!;
    const reference = {
      projectId: first.thread.projectId,
      host: normalizeThreadPullRequestKey(first.link).host,
      repository: first.link.repository,
      number: first.link.number,
    };
    const read = yield* Effect.exit(
      Effect.all([pullRequests.detail(reference), pullRequests.activity(reference)], {
        concurrency: 2,
      }),
    );
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      lastReads.delete(group.key);
      // The host's pause refuses later reads without a request, so waiting it out is free.
      if (isRateLimited(read.cause)) return;
      const count = (failure?.count ?? 0) + 1;
      const passes = Math.min(2 ** (count - 1), MAX_BACKOFF_PASSES);
      readFailures.set(group.key, { count, retryAt: now + passes * SWEEP_MS - 1 });
      if (count >= PULL_REQUEST_WATCH_READ_FAILURE_LIMIT) {
        readFailures.delete(group.key);
        yield* eachTarget(group, giveUp);
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(group.key);
    const [detail, activity] = read.value;
    const headSha = detail.headSha ?? null;
    for (const target of group.targets) {
      const life = lifeOf(target);
      // The first read only learns the head, so it is not a push.
      const pushed = life.headSha !== null && headSha !== life.headSha;
      lives.set(watchId(target), {
        ...life,
        headSha,
        reads: life.reads + 1,
        ...(pushed
          ? { pushedAt: now, longestQuietMs: Math.max(life.longestQuietMs, now - life.pushedAt) }
          : {}),
      });
    }
    if (detail.state !== "open") {
      lastReads.delete(group.key);
      return yield* eachTarget(group, (target) =>
        detail.state === "closed"
          ? closed(target)
          : record(target, null).pipe(Effect.andThen(ended(target, "merged"))),
      );
    }

    const remarks = remarksOf(activity);
    lastReads.set(group.key, {
      at: now,
      fingerprint: group.fingerprint,
      inFlight:
        detail.mergeability === "unknown" ||
        detail.checks.some((check) => check.status === "pending"),
      remarksComplete: remarks !== null,
      watches: new Set(watchIds),
    });
    yield* eachTarget(group, (target) => {
      const report = evaluatePullRequestWatch(target.watch, detail, remarks);
      if (report.changes.length > 0) {
        return deliver(
          target,
          report,
          pullRequestWatchMessage({
            number: target.link.number,
            url: target.link.url,
            baseBranch: detail.baseBranch,
            headSha: report.next.headSha,
            report,
          }),
        );
      }
      pending.delete(watchId(target));
      return pullRequestWatchesEqual(report.next, target.watch)
        ? Effect.void
        : record(target, report.next);
    });
  });

  /** Why a watch ends without a host read. */
  const endsWithoutRead = ({ thread, link }: WatchTarget): WatchEndReason | undefined =>
    link.snapshot?.state === "merged"
      ? "merged"
      : thread.archivedAt !== null
        ? "archived"
        : thread.settledOverride === "settled" || thread.settledAt !== null
          ? "settled"
          : undefined;

  /**
   * Tries the pending wakes of one thread (all when undefined) whose watch has not moved, and
   * returns the watches it tried, which this pass must not evaluate again from the old state.
   */
  const retryPending = (threads: ReadonlyArray<OrchestrationThreadShell>, only?: ThreadId) => {
    const tried = new Set<string>();
    return Effect.forEach(
      [...pending.entries()].filter(
        ([, wake]) => only === undefined || wake.target.thread.id === only,
      ),
      ([id, wake]) => {
        const thread = threads.find((entry) => entry.id === wake.target.thread.id);
        const link = thread?.pullRequests.find(
          (entry) => threadPullRequestKeyOf(entry) === threadPullRequestKeyOf(wake.target.link),
        );
        // A watch that moved or ended since is evaluated afresh by the next pass.
        if (
          thread === undefined ||
          link?.watch === undefined ||
          !pullRequestWatchesEqual(link.watch, wake.target.watch)
        ) {
          pending.delete(id);
          return Effect.void;
        }
        if (isLive(thread)) return Effect.void;
        tried.add(id);
        return deliver({ ...wake.target, thread }, wake.report, wake.text).pipe(
          Effect.catchCause(
            logFailure("pull request watch wake failed", { threadId: thread.id, pullRequest: id }),
          ),
        );
      },
      { discard: true },
    ).pipe(Effect.as(tried));
  };

  const sweep = Effect.gen(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const targets = snapshot.threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    // A watch seen last pass and gone now was ended outside this reactor.
    const present = new Set(targets.map(watchId));
    yield* Effect.forEach(
      [...lives].filter(([id]) => !present.has(id)),
      ([id, life]) => reportEnd(id, life, "stopped"),
      { discard: true },
    );
    for (const id of pending.keys()) if (!present.has(id)) pending.delete(id);
    for (const target of targets) lifeOf(target);
    // Wakes still waiting from an earlier pass, for threads that freed up without an event.
    const retried = yield* retryPending(snapshot.threads);

    const byPullRequest = new Map<string, Array<WatchTarget>>();
    const ending: Array<readonly [WatchTarget, WatchEndReason]> = [];
    for (const target of targets) {
      if (retried.has(watchId(target))) continue;
      const reason = endsWithoutRead(target);
      if (reason !== undefined) {
        ending.push([target, reason]);
        continue;
      }
      // Grouped per project too: each project reads through its own checkout, so one that
      // cannot read the pull request must not end another project's watches.
      const key = `${target.thread.projectId} ${threadPullRequestKeyOf(target.link)}`;
      byPullRequest.set(key, [...(byPullRequest.get(key) ?? []), target]);
    }
    for (const cache of [readFailures, lastReads]) {
      for (const key of cache.keys()) if (!byPullRequest.has(key)) cache.delete(key);
    }
    yield* Effect.forEach(
      ending,
      ([target, reason]) =>
        record(target, null).pipe(
          Effect.andThen(ended(target, reason)),
          Effect.catchCause(
            logFailure("pull request watch stop failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      byPullRequest,
      ([key, members]) =>
        readGroup({
          key,
          targets: members,
          fingerprint: [...new Set(members.map(snapshotFingerprint))].toSorted().join("\n"),
        }).pipe(Effect.catchCause(logFailure("pull request watch check failed", { key }))),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    serial.withPermits(1),
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  // A turn that ended frees its thread for a pending wake.
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    snapshots.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) => retryPending(snapshot.threads, threadId)),
      serial.withPermits(1),
      Effect.asVoid,
      Effect.catchCause(logFailure("pull request watch wake failed", { threadId })),
    ),
  );

  const processEvent = (event: OrchestrationEvent) =>
    Effect.suspend(() => {
      if (event.type !== "thread.session-set") return Effect.void;
      const { threadId, session } = event.payload;
      if (session.status === "running" || session.status === "starting") return Effect.void;
      for (const wake of pending.values()) {
        if (wake.target.thread.id === threadId) return worker.enqueue(threadId);
      }
      return Effect.void;
    });

  const start: PullRequestWatchReactor["Service"]["start"] = Effect.fn(
    "PullRequestWatchReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(
      sweep.pipe(
        Effect.repeat(Schedule.spaced(`${PULL_REQUEST_WATCH_SWEEP_MINUTES} minutes`)),
        Effect.asVoid,
      ),
    );
  });

  return { start, sweep, drain: worker.drain } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
