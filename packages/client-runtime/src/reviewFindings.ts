import {
  type AgentReviewMode,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  ReviewFixStartedActivityPayload,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
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
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICT_LABELS,
} from "@t3tools/shared/reviewFindings";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

/**
 * What every client does with an agent review's findings before drawing them: which set a thread
 * or pull request shows, which review is still under way, the findings in order, and who can fix
 * them. Web draws them over the diff, mobile as a list.
 */

type FindingsActivity = Pick<OrchestrationThreadActivity, "id" | "kind" | "payload" | "createdAt">;

interface ThreadFindings {
  readonly id: ThreadId;
  readonly title: string;
  readonly activities: ReadonlyArray<FindingsActivity>;
}

/** The findings a review view shows, and the review thread that submitted them. */
export interface ReviewFindingsSource {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly activityId: OrchestrationThreadActivity["id"];
  readonly createdAt: string;
  readonly findings: ReviewFindingsActivityPayload;
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
  };
}

/**
 * The newest findings any of these threads submitted about one of these pull requests. A review
 * of something else, such as another layer of a stack, does not count.
 */
export function selectPullRequestReviewFindings(input: {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly threads: ReadonlyArray<ThreadFindings>;
}): ReviewFindingsSource | null {
  let newest: ReviewFindingsSource | null = null;
  for (const thread of input.threads) {
    const source = latestReviewFindingsSource(thread);
    if (source === null || source.findings.target.kind !== "pull-request") continue;
    const target = source.findings.target;
    if (!input.pullRequests.some((key) => threadPullRequestKeysEqual(key, target))) continue;
    if (newest === null || source.createdAt > newest.createdAt) newest = source;
  }
  return newest;
}

/** The newest findings any of these threads submitted about local changes. */
export function selectLocalReviewFindings(
  threads: ReadonlyArray<ThreadFindings>,
): ReviewFindingsSource | null {
  let newest: ReviewFindingsSource | null = null;
  for (const thread of threads) {
    const source = latestReviewFindingsSource(thread);
    if (source === null || source.findings.target.kind !== "local") continue;
    if (newest === null || source.createdAt > newest.createdAt) newest = source;
  }
  return newest;
}

/**
 * Which findings a thread's review view shows: the thread's own latest set when it is itself a
 * review, otherwise the newest set a linked thread submitted about one of this thread's pull
 * requests (`selectPullRequestReviewFindings`), or without pull requests the newest review of its
 * checkout's local changes (`localReviewSourceCandidates`).
 */
export function selectReviewFindingsSource(input: {
  readonly thread: ThreadFindings;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly linkedThreads: ReadonlyArray<ThreadFindings>;
}): ReviewFindingsSource | null {
  const others = input.linkedThreads.filter((thread) => thread.id !== input.thread.id);
  return (
    latestReviewFindingsSource(input.thread) ??
    (input.pullRequests.length > 0
      ? selectPullRequestReviewFindings({ pullRequests: input.pullRequests, threads: others })
      : selectLocalReviewFindings(others))
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

// The titles the server gives a review thread (`pullRequestReviewTitle`, `localReviewTitle`),
// by mode.
const REVIEW_TITLE_PREFIXES: ReadonlyArray<readonly [prefix: string, mode: AgentReviewMode]> = [
  ["Review", "quick"],
  ["Deep review", "deep"],
  ["Security audit", "security"],
];

/** What a review thread is about, as its title names it. */
export type ReviewThreadTarget =
  | { readonly kind: "pull-request"; readonly number: number }
  | { readonly kind: "local" };

/**
 * The kind of review a thread is of this pull request, or of local changes ("Review: local
 * changes", with " on <branch>" when it has one), read from its title; null for any other.
 */
export function reviewThreadMode(
  title: string,
  target: ReviewThreadTarget,
): AgentReviewMode | null {
  const matches = (prefix: string) => {
    if (target.kind === "pull-request") return title.startsWith(`${prefix}: #${target.number} `);
    const head = `${prefix}: local changes`;
    return title === head || title.startsWith(`${head} on `);
  };
  return REVIEW_TITLE_PREFIXES.find(([prefix]) => matches(prefix))?.[1] ?? null;
}

/**
 * The threads that may hold a review of a checkout's local changes, most recently active first:
 * the unarchived reviews of local changes on the same branch and worktree of the project, other
 * than the thread asking. Nothing links a local review to the thread it reviewed, so only threads
 * titled as one are read, which keeps ordinary threads on a shared checkout unsubscribed.
 */
export function localReviewSourceCandidates<
  T extends Pick<
    OrchestrationThreadShell,
    "id" | "title" | "projectId" | "branch" | "worktreePath" | "archivedAt" | "updatedAt"
  >,
>(input: {
  readonly threadId: ThreadId;
  readonly checkout: Pick<OrchestrationThreadShell, "projectId" | "branch" | "worktreePath">;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  const { checkout } = input;
  return input.threads
    .filter(
      (thread) =>
        thread.id !== input.threadId &&
        thread.archivedAt === null &&
        thread.projectId === checkout.projectId &&
        thread.branch === checkout.branch &&
        thread.worktreePath === checkout.worktreePath &&
        reviewThreadMode(thread.title, { kind: "local" }) !== null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, REVIEW_SOURCE_CANDIDATE_LIMIT);
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
 * A review of this pull request, or of local changes, still under way, the newest if there are
 * several: a thread titled as such a review whose turn is running and which has not submitted
 * findings yet. Nothing else marks a review thread, so a renamed one reads as an ordinary thread.
 */
export function selectRunningReview<
  T extends ThreadFindings & { readonly createdAt: string; readonly running: boolean },
>(input: {
  readonly target: ReviewThreadTarget;
  readonly threads: ReadonlyArray<T>;
}): { readonly thread: T; readonly mode: AgentReviewMode } | null {
  let newest: { readonly thread: T; readonly mode: AgentReviewMode } | null = null;
  for (const thread of input.threads) {
    const mode = reviewThreadMode(thread.title, input.target);
    if (mode === null || !thread.running) continue;
    if (latestReviewFindingsActivity(thread.activities) !== undefined) continue;
    if (newest === null || thread.createdAt > newest.thread.createdAt) newest = { thread, mode };
  }
  return newest;
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
>;

/**
 * The sessions already working on what a review looked at, most recently active first: threads
 * linked to the reviewed pull request, or for a local review the threads on the review's own
 * checkout. The review thread is never one of them: reviewers do not fix. With exactly one, it is
 * the obvious choice and comes preselected.
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
