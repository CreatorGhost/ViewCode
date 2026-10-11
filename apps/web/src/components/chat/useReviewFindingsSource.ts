import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  type AgentReviewMode,
  type EnvironmentId,
  type ModelSelection,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ScopedThreadRef,
  ThreadId,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { type PostedReviewFinding, postedReviewFindings } from "@t3tools/shared/reviewFindings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import {
  latestReviewFindingsActivity,
  reviewSourceCandidates,
  type ReviewFindingsSource,
  selectPullRequestReviewFindings,
  selectReviewFindingsSource,
  selectRunningPullRequestReview,
  threadTurnRunning,
} from "./reviewPanel.logic";

const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NO_POSTED: ReadonlyMap<string, PostedReviewFinding> = new Map();

/** A thread that may hold a review of a pull request, with only what the selectors read. */
interface LinkedReviewThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
  readonly running: boolean;
  /** Its findings, and what was posted from them. */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

const NO_LINKED: ReadonlyArray<LinkedReviewThread> = [];
const NO_LINKED_ATOM = Atom.make(NO_LINKED).pipe(Atom.withLabel("web-linked-reviews:empty"));

function isReviewActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND ||
    activity.kind === REVIEW_FINDINGS_POSTED_ACTIVITY_KIND
  );
}

function linkedThreadEqual(left: LinkedReviewThread, right: LinkedReviewThread): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.running === right.running &&
    left.modelSelection.instanceId === right.modelSelection.instanceId &&
    left.modelSelection.model === right.modelSelection.model &&
    arrayElementsEqual(left.activities, right.activities)
  );
}

interface LinkedReviewsKey {
  readonly environmentId: EnvironmentId;
  /** The thread asking, which is not one of its own linked threads; null on the pull request page. */
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
}

function linkedReviewsKey(key: LinkedReviewsKey): string {
  return JSON.stringify([
    key.environmentId,
    key.threadId,
    key.pullRequests.map(({ host, repository, number }) => [host, repository, number]),
  ]);
}

/**
 * The threads that may hold a review of some pull requests (see `reviewSourceCandidates`), each
 * with its review activities. Reading a thread's activities subscribes to it, so this only lives
 * while something on screen needs it; and it settles on the same array until a field the review
 * selectors read changes, so a linked thread's ordinary work does not re-render its readers.
 */
const linkedReviewThreadsAtomFamily = Atom.family((serialized: string) => {
  const [environmentId, threadId, pullRequests] = JSON.parse(serialized) as [
    EnvironmentId,
    ThreadId | null,
    ReadonlyArray<[string, string, number]>,
  ];
  const keys = pullRequests.map(([host, repository, number]) => ({ host, repository, number }));
  let previous: ReadonlyArray<LinkedReviewThread> = NO_LINKED;
  return Atom.make((get) => {
    const candidates = reviewSourceCandidates({
      threadId: threadId === null ? null : ThreadId.make(threadId),
      pullRequests: keys,
      threads: get(environmentThreadShells.threadShellsAtom).filter(
        (shell) => shell.environmentId === environmentId,
      ),
    });
    // By id rather than by activity, so two busy threads trading places is not a change.
    const next = candidates
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((shell): LinkedReviewThread => {
        const activities = get(
          environmentThreadDetails.activitiesAtom(scopeThreadRef(environmentId, shell.id)),
        ).filter(isReviewActivity);
        const linked: LinkedReviewThread = {
          id: shell.id,
          title: shell.title,
          createdAt: shell.createdAt,
          modelSelection: shell.modelSelection,
          running: threadTurnRunning(shell),
          activities,
        };
        const before = previous.find((entry) => entry.id === shell.id);
        return before !== undefined && linkedThreadEqual(before, linked) ? before : linked;
      });
    if (arrayElementsEqual(next, previous)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-linked-reviews:${serialized}`));
});

function useLinkedReviewThreads(key: LinkedReviewsKey | null): ReadonlyArray<LinkedReviewThread> {
  const serialized = key === null || key.pullRequests.length === 0 ? null : linkedReviewsKey(key);
  return useAtomValue(
    serialized === null ? NO_LINKED_ATOM : linkedReviewThreadsAtomFamily(serialized),
  );
}

function usePostedFindings(
  source: ReviewFindingsSource | null,
  sourceActivities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, PostedReviewFinding> {
  const sourceActivityId = source?.activityId ?? null;
  return useMemo(
    () =>
      sourceActivityId === null
        ? NO_POSTED
        : postedReviewFindings(sourceActivities, sourceActivityId),
    [sourceActivities, sourceActivityId],
  );
}

/**
 * The findings a thread's Review panel shows (see `selectReviewFindingsSource`), which of them
 * were posted to the pull request, and the pull requests a new review of it would look at.
 * Linked threads are only read while the thread has no findings of its own.
 */
export function useReviewFindingsSource(threadRef: ScopedThreadRef): {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly projectId: ProjectId | null;
} {
  const shell = useThreadShell(threadRef);
  const activities =
    useAtomValue(environmentThreadDetails.activitiesAtom(threadRef)) ?? NO_ACTIVITIES;
  const pullRequests = useMemo(
    () => visibleThreadPullRequests(shell?.pullRequests ?? []),
    [shell?.pullRequests],
  );
  const hasOwnFindings = latestReviewFindingsActivity(activities) !== undefined;
  const linkedThreads = useLinkedReviewThreads(
    hasOwnFindings
      ? null
      : { environmentId: threadRef.environmentId, threadId: threadRef.threadId, pullRequests },
  );
  const title = shell?.title ?? "";
  const source = useMemo(
    () =>
      selectReviewFindingsSource({
        thread: { id: threadRef.threadId, title, activities },
        pullRequests,
        linkedThreads,
      }),
    [activities, linkedThreads, pullRequests, threadRef.threadId, title],
  );
  const sourceActivities =
    source === null
      ? NO_ACTIVITIES
      : source.threadId === threadRef.threadId
        ? activities
        : (linkedThreads.find((thread) => thread.id === source.threadId)?.activities ??
          NO_ACTIVITIES);
  const posted = usePostedFindings(source, sourceActivities);
  return { source, posted, pullRequests, projectId: shell?.projectId ?? null };
}

/** A review of a pull request still under way (see `selectRunningPullRequestReview`). */
export interface RunningPullRequestReview {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly mode: AgentReviewMode;
  readonly modelSelection: ModelSelection;
}

/**
 * What the pull request page shows of agent reviews of one pull request: the newest findings any
 * linked thread submitted about it, which of them were posted, and a review still under way. Null
 * for a pull request no thread can be linked to.
 */
export function usePullRequestReviewFindings(
  environmentId: EnvironmentId,
  pullRequest: ThreadPullRequestKey | null,
): {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly running: RunningPullRequestReview | null;
} {
  const pullRequests = useMemo(() => (pullRequest === null ? [] : [pullRequest]), [pullRequest]);
  const linkedThreads = useLinkedReviewThreads(
    pullRequest === null ? null : { environmentId, threadId: null, pullRequests },
  );
  const source = useMemo(
    () => selectPullRequestReviewFindings({ pullRequests, threads: linkedThreads }),
    [linkedThreads, pullRequests],
  );
  const runningReview = useMemo(
    () =>
      pullRequest === null
        ? null
        : selectRunningPullRequestReview({ number: pullRequest.number, threads: linkedThreads }),
    [linkedThreads, pullRequest],
  );
  const running = useMemo<RunningPullRequestReview | null>(
    () =>
      runningReview === null
        ? null
        : {
            threadId: runningReview.thread.id,
            title: runningReview.thread.title,
            mode: runningReview.mode,
            modelSelection: runningReview.thread.modelSelection,
          },
    [runningReview],
  );
  const sourceActivities =
    source === null
      ? NO_ACTIVITIES
      : (linkedThreads.find((thread) => thread.id === source.threadId)?.activities ??
        NO_ACTIVITIES);
  const posted = usePostedFindings(source, sourceActivities);
  return { source, posted, running };
}
