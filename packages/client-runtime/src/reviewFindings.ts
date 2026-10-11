import {
  type AgentReviewMode,
  type LocalReviewScope,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  ReviewFixStartedActivityPayload,
  ReviewStartedActivityPayload,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProjectId,
  type PullRequestRef,
  type ReviewBasedOnInput,
  type ReviewFinding,
  type ReviewFindingRating,
  type ReviewFindingSeverity,
  type ReviewFindingsActivityPayload,
  type ReviewFindingsTarget,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type PostedReviewFinding,
  readReviewFindings,
  reviewFindingIdentity,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICT_LABELS,
} from "@t3tools/shared/reviewFindings";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

/**
 * What every client does with an agent review's findings before drawing them: which set a thread
 * or pull request shows, where the latest review stands, the findings in order, and who can fix
 * them. Web draws them over the diff, mobile as a list.
 */

type FindingsActivity = Pick<OrchestrationThreadActivity, "id" | "kind" | "payload" | "createdAt">;

interface ThreadFindings {
  readonly id: ThreadId;
  readonly title: string;
  readonly activities: ReadonlyArray<FindingsActivity>;
  /** A child agent of the thread asking, whose reviews count whatever they reviewed. */
  readonly child?: boolean;
}

/** The findings a review view shows, and the review thread that submitted them. */
export interface ReviewFindingsSource {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly activityId: OrchestrationThreadActivity["id"];
  readonly createdAt: string;
  readonly findings: ReviewFindingsActivityPayload;
  /** What of the local changes the review was asked to read; null for the default or a PR. */
  readonly scope: LocalReviewScope | null;
}

/** A thread's latest findings activity; activities are append-only, so a re-review comes last. */
export function latestReviewFindingsActivity<T extends Pick<FindingsActivity, "kind">>(
  activities: ReadonlyArray<T>,
): T | undefined {
  return activities.findLast((activity) => activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND);
}

// Activities are immutable, so a payload is decoded once however often a view recomputes.
const decodedFindings = new WeakMap<FindingsActivity, ReviewFindingsActivityPayload | null>();

function decodeFindings(activity: FindingsActivity): ReviewFindingsActivityPayload | null {
  let findings = decodedFindings.get(activity);
  if (findings === undefined) {
    findings = readReviewFindings(activity) ?? null;
    decodedFindings.set(activity, findings);
  }
  return findings;
}

/** A thread's own latest findings, or null when it submitted none that decode. */
export function latestReviewFindingsSource(thread: ThreadFindings): ReviewFindingsSource | null {
  const activity = latestReviewFindingsActivity(thread.activities);
  const findings = activity === undefined ? null : decodeFindings(activity);
  if (activity === undefined || findings === null) return null;
  return {
    threadId: thread.id,
    threadTitle: thread.title,
    activityId: activity.id,
    createdAt: activity.createdAt,
    findings,
    scope: reviewStartedRecord(thread.activities)?.scope ?? null,
  };
}

/** The newest findings among these threads that `accept` takes. */
function newestFindings<T extends ThreadFindings>(
  threads: ReadonlyArray<T>,
  accept: (source: ReviewFindingsSource, thread: T) => boolean,
): ReviewFindingsSource | null {
  let newest: ReviewFindingsSource | null = null;
  for (const thread of threads) {
    const source = latestReviewFindingsSource(thread);
    if (source === null || !accept(source, thread)) continue;
    if (newest === null || source.createdAt > newest.createdAt) newest = source;
  }
  return newest;
}

function aboutPullRequests(
  source: ReviewFindingsSource,
  pullRequests: ReadonlyArray<ThreadPullRequestKey>,
): boolean {
  const { target } = source.findings;
  return (
    target.kind === "pull-request" &&
    pullRequests.some((key) => threadPullRequestKeysEqual(key, target))
  );
}

/**
 * The newest findings any of these threads submitted about one of these pull requests. A review
 * of something else, such as another layer of a stack, does not count.
 */
export function selectPullRequestReviewFindings(input: {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly threads: ReadonlyArray<ThreadFindings>;
}): ReviewFindingsSource | null {
  return newestFindings(input.threads, (source) => aboutPullRequests(source, input.pullRequests));
}

/**
 * Which findings a thread's review view shows: the thread's own latest set when it is itself a
 * review, otherwise the newest set one of its review child agents submitted, whatever it
 * reviewed, or a linked thread submitted about one of this thread's pull requests.
 */
export function selectReviewFindingsSource(input: {
  readonly thread: ThreadFindings;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly linkedThreads: ReadonlyArray<ThreadFindings>;
}): ReviewFindingsSource | null {
  const others = input.linkedThreads.filter((thread) => thread.id !== input.thread.id);
  return (
    latestReviewFindingsSource(input.thread) ??
    newestFindings(
      others,
      (source, thread) => thread.child === true || aboutPullRequests(source, input.pullRequests),
    )
  );
}

/** How many linked threads a view reads for findings; each one is a thread subscription. */
export const REVIEW_SOURCE_CANDIDATE_LIMIT = 5;

/**
 * The threads that may hold a review of these pull requests, most recently active first: the
 * unarchived threads linked to one of them, other than the thread asking (null on a pull request
 * page, which is no thread). Only these have their activities read.
 */
export function reviewSourceCandidates<
  T extends Pick<OrchestrationThreadShell, "id" | "pullRequests" | "archivedAt" | "updatedAt">,
>(input: {
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  if (input.pullRequests.length === 0) return [];
  return input.threads
    .filter(
      (thread) =>
        thread.id !== input.threadId &&
        thread.archivedAt === null &&
        visibleThreadPullRequests(thread.pullRequests).some((link) =>
          input.pullRequests.some((key) => threadPullRequestKeysEqual(link, key)),
        ),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, REVIEW_SOURCE_CANDIDATE_LIMIT);
}

/**
 * The threads a thread's review view reads, most recently active first: the thread itself (it may
 * be a review), its child agents (reviews started from it run as its children) and the threads
 * linked to its pull requests (`reviewSourceCandidates`). Children come before linked threads, at
 * most `REVIEW_SOURCE_CANDIDATE_LIMIT` besides the thread itself.
 */
export function threadReviewCandidates<
  T extends Pick<
    OrchestrationThreadShell,
    "id" | "parentThreadId" | "kind" | "pullRequests" | "archivedAt" | "updatedAt"
  >,
>(input: {
  readonly threadId: ThreadId;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  const self = input.threads.find((thread) => thread.id === input.threadId);
  const children = input.threads
    .filter(
      (thread) =>
        thread.parentThreadId === input.threadId &&
        thread.kind !== "sidechat" &&
        thread.archivedAt === null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const linked = reviewSourceCandidates(input).filter((thread) => !children.includes(thread));
  return [
    ...(self === undefined ? [] : [self]),
    ...[...children, ...linked].slice(0, REVIEW_SOURCE_CANDIDATE_LIMIT),
  ];
}

const decodeStarted = Schema.decodeUnknownOption(ReviewStartedActivityPayload);

/** What a review was started as, from the hidden record the server leaves on its thread. */
export interface ReviewStartedRecord {
  /** Absent from reviews started before it was recorded. */
  readonly mode: AgentReviewMode | null;
  readonly focus: string | null;
  /** What a review of local changes was asked to read; null for the default. */
  readonly scope: LocalReviewScope | null;
}

const startedRecords = new WeakMap<FindingsActivity, ReviewStartedRecord | null>();

/**
 * How the thread's latest review was started; null for a thread that is no review. The record is
 * what tells a review thread apart, whatever it is titled.
 */
export function reviewStartedRecord(
  activities: ReadonlyArray<FindingsActivity>,
): ReviewStartedRecord | null {
  const activity = activities.findLast((entry) => entry.kind === REVIEW_STARTED_ACTIVITY_KIND);
  if (activity === undefined) return null;
  let record = startedRecords.get(activity);
  if (record === undefined) {
    const payload = Option.getOrUndefined(decodeStarted(activity.payload));
    record =
      payload === undefined
        ? null
        : {
            mode: payload.mode ?? null,
            focus: payload.focus ?? null,
            scope: payload.scope ?? null,
          };
    startedRecords.set(activity, record);
  }
  return record;
}

type RunShell = Pick<OrchestrationThreadShell, "session" | "latestTurn">;

/** Where a review thread's work stands, from its own and its agents' turns. */
export type ReviewRunState =
  | { readonly kind: "running" }
  | { readonly kind: "failed"; readonly error: string | null }
  | { readonly kind: "ended" };

const RUNNING: ReviewRunState = { kind: "running" };
const ENDED: ReviewRunState = { kind: "ended" };

function agentTurnInFlight(thread: RunShell): boolean {
  const status = thread.session?.status;
  return status === "starting" || status === "running" || thread.latestTurn?.state === "running";
}

/**
 * Whether a review is still at work. A reviewer that started agents (a deep review, a security
 * audit) ends its turn and is woken by each agent's answer, so it runs while it or any of its
 * agents is in flight, or has agent messages queued (an answer waiting for a busy or paused
 * reviewer). Once the whole tree is idle or stopped with nothing queued it failed, with the
 * provider's error, or ended: an agent that finished without answering does not keep it running.
 * `queued` is how many agent messages wait for a thread (zero where the client cannot tell).
 */
export function reviewRunState(
  review: RunShell & { readonly id: ThreadId },
  agents: ReadonlyArray<RunShell & { readonly id: ThreadId }>,
  queued: (threadId: ThreadId) => number = () => 0,
): ReviewRunState {
  if (reviewTurnInFlight(review) || queued(review.id) > 0) return RUNNING;
  for (const agent of agents) {
    if (agentTurnInFlight(agent) || queued(agent.id) > 0) return RUNNING;
  }
  if (review.latestTurn?.state === "error" || review.session?.status === "error") {
    return { kind: "failed", error: review.session?.lastError ?? null };
  }
  return ENDED;
}

export function reviewRunStatesEqual(left: ReviewRunState, right: ReviewRunState): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "failed" || right.kind !== "failed" || left.error === right.error)
  );
}

/**
 * Where a review stands for its reader: done once it sent its final findings, otherwise running,
 * failed or ended as its turns say, with or without findings sent so far (`complete: false`).
 */
export type ReviewProgress =
  | { readonly kind: "done" }
  | (ReviewRunState & { readonly partial: boolean });

export function reviewProgress(input: {
  readonly run: ReviewRunState;
  readonly findings: Pick<ReviewFindingsActivityPayload, "complete"> | null;
}): ReviewProgress {
  if (input.findings !== null && input.findings.complete !== false) return { kind: "done" };
  return { ...input.run, partial: input.findings !== null };
}

/** Recorded when a provider fails a turn (`runtime.error`); a review reads it to say why. */
export const RUNTIME_ERROR_ACTIVITY_KIND = "runtime.error";

/**
 * The last provider error a review hit since it started, if any. A deep review whose lead failed
 * is woken again by its agents' answers into turns that complete, so the failure is only in the
 * record of what happened, not in where its turns stand now.
 */
export function reviewErrorSinceStart(
  activities: ReadonlyArray<Pick<FindingsActivity, "kind" | "payload">>,
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind === REVIEW_STARTED_ACTIVITY_KIND) return null;
    if (activity.kind !== RUNTIME_ERROR_ACTIVITY_KIND) continue;
    const payload = activity.payload;
    const message =
      payload !== null && typeof payload === "object" && "message" in payload
        ? payload.message
        : undefined;
    return typeof message === "string" && message.trim().length > 0 ? message : "";
  }
  return null;
}

/** The latest review a view knows of, as `selectLatestReview` finds it. */
export interface LatestReview<T> {
  readonly thread: T;
  readonly mode: AgentReviewMode;
  readonly focus: string | null;
  readonly scope: LocalReviewScope | null;
  readonly progress: ReviewProgress;
}

/**
 * The newest review among these threads (those with a start record), and where it stands. Old
 * reviews that recorded no mode read as quick ones.
 */
export function selectLatestReview<
  T extends ThreadFindings & { readonly createdAt: string; readonly run: ReviewRunState },
>(threads: ReadonlyArray<T>): LatestReview<T> | null {
  let newest: { readonly thread: T; readonly started: ReviewStartedRecord } | null = null;
  for (const thread of threads) {
    const started = reviewStartedRecord(thread.activities);
    if (started === null) continue;
    if (newest === null || thread.createdAt > newest.thread.createdAt) newest = { thread, started };
  }
  if (newest === null) return null;
  const { thread, started } = newest;
  // A review that stopped after a provider error failed, whatever turns ran after it.
  const error = thread.run.kind === "running" ? null : reviewErrorSinceStart(thread.activities);
  const run: ReviewRunState =
    error === null
      ? thread.run
      : {
          kind: "failed",
          error:
            thread.run.kind === "failed" && thread.run.error ? thread.run.error : error || null,
        };
  return {
    thread,
    mode: started.mode ?? "quick",
    focus: started.focus,
    scope: started.scope,
    progress: reviewProgress({
      run,
      findings: latestReviewFindingsSource(thread)?.findings ?? null,
    }),
  };
}

/**
 * Whether a review thread's session or latest turn is in flight. A review is created with its
 * first turn, which counts from the moment it is asked for: until a session adopts it, the thread
 * has neither a session nor a turn.
 */
export function reviewTurnInFlight(
  thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
): boolean {
  if (thread.session === null && thread.latestTurn === null) return true;
  const status = thread.session?.status;
  return status === "starting" || status === "running" || thread.latestTurn?.state === "running";
}

/**
 * Ratings as the reader sees them: the server's, with the reader's own clicks on top until the
 * server records them (null is a rating taken back).
 */
export function mergeReviewFindingRatings(
  server: ReadonlyMap<string, ReviewFindingRating>,
  optimistic: ReadonlyMap<string, ReviewFindingRating | null>,
): ReadonlyMap<string, ReviewFindingRating> {
  if (optimistic.size === 0) return server;
  const merged = new Map(server);
  for (const [key, rating] of optimistic) {
    if (rating === null) merged.delete(key);
    else merged.set(key, rating);
  }
  return merged;
}

/**
 * The clicks the server has not recorded yet: those it now agrees with are dropped, so a later
 * rating from another client shows. The same map when nothing settled.
 */
export function unsettledReviewFindingRatings(
  server: ReadonlyMap<string, ReviewFindingRating>,
  optimistic: ReadonlyMap<string, ReviewFindingRating | null>,
): ReadonlyMap<string, ReviewFindingRating | null> {
  const pending = [...optimistic].filter(([key, rating]) => (server.get(key) ?? null) !== rating);
  return pending.length === optimistic.size ? optimistic : new Map(pending);
}

export function reviewFindingRatingsEqual(
  left: ReadonlyMap<string, ReviewFindingRating>,
  right: ReadonlyMap<string, ReviewFindingRating>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, rating] of left) {
    if (right.get(key) !== rating) return false;
  }
  return true;
}

/** What posting says when the pull request has commits its review did not read. */
export const REVIEW_HEAD_MOVED_NOTICE =
  "The pull request changed since this review; comments go on the reviewed commit and may show as outdated.";

/**
 * Whether the pull request's head is past the commit its review read, either named in full or
 * abbreviated; false while either is unknown.
 */
export function reviewHeadMoved(
  reviewedHeadSha: string | undefined,
  currentHeadSha: string | undefined,
): boolean {
  if (reviewedHeadSha === undefined || currentHeadSha === undefined) return false;
  const reviewed = reviewedHeadSha.toLowerCase();
  const current = currentHeadSha.toLowerCase();
  return !reviewed.startsWith(current) && !current.startsWith(reviewed);
}

/** What a re-review of a set of findings starts from (see `reviewRereviewBasis`). */
export interface ReviewRereviewBasis {
  readonly basedOn: ReviewBasedOnInput;
  /**
   * The earlier review named the commit it read, so the server can review only what was pushed
   * since. Without one (a local review, or a host that did not say) a re-review reads the whole
   * change again, still checking the earlier findings.
   */
  readonly onlyChanges: boolean;
}

/**
 * Whether a new review from `request` can re-review these findings: it reads the same pull
 * request, or local changes again. The server refuses findings about anything else.
 */
export function reviewRereviewBasis(
  source: Pick<ReviewFindingsSource, "threadId" | "activityId" | "findings">,
  request:
    | {
        readonly kind: "pull-request";
        readonly reference: Pick<PullRequestRef, "host" | "repository" | "number">;
      }
    | { readonly kind: "local" },
): ReviewRereviewBasis | null {
  const { target } = source.findings;
  const sameTarget =
    request.kind === "local"
      ? target.kind === "local"
      : target.kind === "pull-request" &&
        threadPullRequestKeysEqual(
          // A reference without a host means the project's own host, which reviewed it.
          { ...request.reference, host: request.reference.host ?? target.host },
          target,
        );
  if (!sameTarget) return null;
  return {
    basedOn: { threadId: source.threadId, activityId: source.activityId },
    onlyChanges: source.findings.headSha !== undefined,
  };
}

/** "Re-review · 2 fixed · 1 still open" for findings of a re-review; null for a first review. */
export function reviewRereviewSummary(
  findings: Pick<ReviewFindingsActivityPayload, "incremental" | "previous">,
): string | null {
  if (findings.previous !== undefined) {
    return `Re-review · ${findings.previous.fixed} fixed · ${findings.previous.stillOpen} still open`;
  }
  return findings.incremental === true ? "Re-review" : null;
}

/** A finding's place in the payload: which list, and its index there. */
export type ReviewFindingKey = `${"finding" | "check"}:${number}`;

export interface ReviewFindingEntry {
  readonly key: ReviewFindingKey;
  readonly finding: ReviewFinding;
  /** The reviewer could not settle it. */
  readonly needsChecking: boolean;
}

export { reviewFindingIdentity };

/** Every finding of a set, the settled ones first, each under a key that survives re-renders. */
export function reviewFindingEntries(
  findings: Pick<ReviewFindingsActivityPayload, "findings" | "needsChecking">,
): ReadonlyArray<ReviewFindingEntry> {
  return [
    ...findings.findings.map((finding, index) => ({
      key: `finding:${index}` as const,
      finding,
      needsChecking: false,
    })),
    ...findings.needsChecking.map((finding, index) => ({
      key: `check:${index}` as const,
      finding,
      needsChecking: true,
    })),
  ];
}

/**
 * The reader's marks on findings (dismissed, sent to a chat), kept by finding identity so they
 * hold across the sets one review sends, as they apply to this set's keys.
 */
export function reviewFindingMarksByKey<T>(
  entries: ReadonlyArray<ReviewFindingEntry>,
  marks: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  const byKey: Record<string, T> = {};
  for (const entry of entries) {
    const mark = marks[reviewFindingIdentity(entry.finding)];
    if (mark !== undefined) byKey[entry.key] = mark;
  }
  return byKey;
}

/**
 * What Fix all does: nothing without open findings, sends one straight away, and lists several
 * first so some can be left out.
 */
export function reviewFixAllMode(openCount: number): "none" | "send" | "choose" {
  return openCount === 0 ? "none" : openCount === 1 ? "send" : "choose";
}

/**
 * Whether Post all waits: a review still at work may change or drop the findings it sent so far.
 * A single finding, or ticked ones, can be posted meanwhile.
 */
export function reviewPostAllWaits(input: {
  readonly commentMode: boolean;
  readonly tickedCount: number;
  readonly stillReviewing: boolean;
}): boolean {
  return input.commentMode && input.tickedCount === 0 && input.stillReviewing;
}

/**
 * Findings by severity, most severe first, each group in the order the reviewer gave them with
 * the settled ones first. Severities without findings are left out.
 */
export function groupReviewFindingsBySeverity(
  entries: ReadonlyArray<ReviewFindingEntry>,
): ReadonlyArray<{
  readonly severity: ReviewFindingSeverity;
  readonly entries: ReadonlyArray<ReviewFindingEntry>;
}> {
  return REVIEW_FINDING_SEVERITIES.flatMap((severity) => {
    const group = entries.filter((entry) => entry.finding.severity === severity);
    return group.length === 0 ? [] : [{ severity, entries: group }];
  });
}

/** How many findings of a set are still to act on: neither dismissed nor posted. */
export function openReviewFindingCount(
  findings: Pick<ReviewFindingsActivityPayload, "findings" | "needsChecking">,
  dismissed: Readonly<Record<string, true>>,
  posted: ReadonlyMap<string, PostedReviewFinding>,
): number {
  return reviewFindingEntries(findings).filter(
    (entry) => dismissed[entry.key] !== true && !posted.has(entry.key),
  ).length;
}

/**
 * Where a posted review's own text starts until the reader rewrites it: the reviewer's verdict,
 * then the two most severe findings being posted, the settled ones first.
 */
export function reviewPostOverallComment(
  verdict: ReviewFindingsActivityPayload["verdict"],
  entries: ReadonlyArray<ReviewFindingEntry>,
): string {
  const top = [...entries]
    .sort(
      (left, right) =>
        Number(left.needsChecking) - Number(right.needsChecking) ||
        REVIEW_FINDING_SEVERITIES.indexOf(left.finding.severity) -
          REVIEW_FINDING_SEVERITIES.indexOf(right.finding.severity),
    )
    .slice(0, 2)
    .map((entry) => `- ${entry.finding.title}`);
  return [`${REVIEW_VERDICT_LABELS[verdict]}.`, ...(top.length > 0 ? [top.join("\n")] : [])].join(
    "\n\n",
  );
}

type FixCandidateThread = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "branch" | "worktreePath" | "pullRequests" | "archivedAt" | "updatedAt"
> &
  Partial<Pick<OrchestrationThreadShell, "parentThreadId">>;

/**
 * The sessions already working on what a review looked at, most recently active first: threads
 * linked to the reviewed pull request, or for a local review the threads on the review's own
 * checkout. The review thread is never one of them: reviewers do not fix. Nor is any child agent
 * or side chat, which belongs to its parent chat (a reviewer's own lens agents among them). With
 * exactly one, it is the obvious choice and comes preselected.
 */
export function reviewFixCandidates<T extends FixCandidateThread>(input: {
  readonly reviewThread: Pick<FixCandidateThread, "id" | "projectId" | "branch" | "worktreePath">;
  readonly target: ReviewFindingsTarget;
  readonly threads: ReadonlyArray<T>;
}): { readonly candidates: ReadonlyArray<T>; readonly preselectedId: ThreadId | null } {
  const { reviewThread, target } = input;
  const candidates = input.threads
    .filter((thread) => {
      if (thread.id === reviewThread.id || thread.archivedAt !== null) return false;
      if (thread.parentThreadId != null) return false;
      if (target.kind === "pull-request") {
        return visibleThreadPullRequests(thread.pullRequests).some((link) =>
          threadPullRequestKeysEqual(link, target),
        );
      }
      return (
        thread.projectId === reviewThread.projectId &&
        thread.branch === reviewThread.branch &&
        thread.worktreePath === reviewThread.worktreePath
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { candidates, preselectedId: candidates.length === 1 ? candidates[0]!.id : null };
}

/** Where a review's findings go to be fixed, when the view has no chat beside it. */
export type ReviewFixChatChoice<T> =
  | { readonly kind: "thread"; readonly thread: T }
  | {
      readonly kind: "new";
      readonly projectId: ProjectId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    };

/**
 * The chat that fixes a review's findings when the view has no chat beside it (the reviewer's own
 * thread, the pull request page): the chat the review was started from (its parent), else the
 * chat most recently working on what it reviewed (`reviewFixCandidates`, never an agent), else a
 * new chat on the reviewed checkout. Null without a project to open one in.
 */
export function selectReviewFixChat<
  T extends FixCandidateThread & Partial<Pick<OrchestrationThreadShell, "kind">>,
>(input: {
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly target: ReviewFindingsTarget;
  /** The environment's threads, the reviewer among them when it is loaded. */
  readonly threads: ReadonlyArray<T>;
}): ReviewFixChatChoice<T> | null {
  const reviewer = input.threads.find((thread) => thread.id === input.reviewThreadId);
  const parentId = reviewer?.kind === "sidechat" ? null : (reviewer?.parentThreadId ?? null);
  const parent =
    parentId === null ? undefined : input.threads.find((thread) => thread.id === parentId);
  if (parent !== undefined && parent.archivedAt === null) return { kind: "thread", thread: parent };
  const projectId = input.projectId ?? reviewer?.projectId ?? null;
  if (projectId === null) return null;
  const [chat] = reviewFixCandidates({
    reviewThread: reviewer ?? {
      id: input.reviewThreadId,
      projectId,
      branch: null,
      worktreePath: null,
    },
    target: input.target,
    threads: input.threads,
  }).candidates;
  if (chat !== undefined) return { kind: "thread", thread: chat };
  const local = input.target.kind === "local";
  return {
    kind: "new",
    projectId,
    branch: local ? (reviewer?.branch ?? null) : null,
    worktreePath: local ? (reviewer?.worktreePath ?? null) : null,
  };
}

const decodeFixStarted = Schema.decodeUnknownOption(ReviewFixStartedActivityPayload);

/**
 * What undoing a review fix session takes back: the checkpoint before the fix, which the server
 * recorded when it started the session, and how many turns lie past it. Null for a session not
 * started to fix findings.
 */
export function reviewFixUndo(thread: {
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>;
  readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
}): { readonly turnCount: number; readonly undoneTurns: number } | null {
  const marker = thread.activities.findLast(
    (activity) => activity.kind === REVIEW_FIX_STARTED_ACTIVITY_KIND,
  );
  const started =
    marker === undefined ? undefined : Option.getOrUndefined(decodeFixStarted(marker.payload));
  if (started === undefined) return null;
  const current = thread.checkpoints.reduce(
    (latest, checkpoint) => Math.max(latest, checkpoint.checkpointTurnCount),
    0,
  );
  return {
    turnCount: started.turnCountBefore,
    undoneTurns: Math.max(0, current - started.turnCountBefore),
  };
}
