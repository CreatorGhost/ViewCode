import { useAtomValue } from "@effect/atom-react";
import {
  latestReviewFindingsActivity,
  openReviewFindingCount,
  type ReviewFindingsSource,
  selectPullRequestReviewFindings,
  type ReviewThreadTarget,
  reviewTurnInFlight,
  selectReviewFindingsSource,
  selectRunningReview,
} from "@t3tools/client-runtime/review-findings";
import {
  createLinkedReviewThreadsAtomFamily,
  type LinkedReviewsKey,
  type LinkedReviewThread,
} from "@t3tools/client-runtime/state/review-findings";
import type {
  AgentReviewMode,
  EnvironmentId,
  ModelSelection,
  OrchestrationThreadActivity,
  ProjectId,
  ReviewFindingRating,
  ScopedThreadRef,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type PostedReviewFinding,
  postedReviewFindings,
  reviewFindingRatings,
} from "@t3tools/shared/reviewFindings";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { reviewFindingsCardKey, useReviewFixSentStore } from "./reviewFixSentStore";

const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NO_POSTED: ReadonlyMap<string, PostedReviewFinding> = new Map();
const NO_RATINGS: ReadonlyMap<string, ReviewFindingRating> = new Map();

const linkedReviewThreadsAtom = createLinkedReviewThreadsAtomFamily({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  activitiesAtom: environmentThreadDetails.activitiesAtom,
  label: "web-linked-reviews",
});

function useLinkedReviewThreads(key: LinkedReviewsKey | null): ReadonlyArray<LinkedReviewThread> {
  return useAtomValue(linkedReviewThreadsAtom(key));
}

/** Which findings of the source were posted, and how they are rated, from its thread's records. */
function useFindingRecords(
  source: ReviewFindingsSource | null,
  sourceActivities: ReadonlyArray<OrchestrationThreadActivity>,
): {
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
} {
  const sourceActivityId = source?.activityId ?? null;
  return useMemo(
    () =>
      sourceActivityId === null
        ? { posted: NO_POSTED, ratings: NO_RATINGS }
        : {
            posted: postedReviewFindings(sourceActivities, sourceActivityId),
            ratings: reviewFindingRatings(sourceActivities, sourceActivityId),
          },
    [sourceActivities, sourceActivityId],
  );
}

/** A review still under way (see `selectRunningReview`). */
export interface RunningReview {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly mode: AgentReviewMode;
  readonly modelSelection: ModelSelection;
}

function useRunningReview(
  target: ReviewThreadTarget | null,
  threads: ReadonlyArray<LinkedReviewThread>,
): RunningReview | null {
  const running = useMemo(
    () => (target === null ? null : selectRunningReview({ target, threads })),
    [target, threads],
  );
  return useMemo(
    () =>
      running === null
        ? null
        : {
            threadId: running.thread.id,
            title: running.thread.title,
            mode: running.mode,
            modelSelection: running.thread.modelSelection,
          },
    [running],
  );
}

/**
 * The findings a thread's Review panel shows (see `selectReviewFindingsSource`), which of them
 * were posted to the pull request, the pull requests a new review of it would look at, and a
 * review of the current one (or of the thread's local changes, without one) still under way.
 * Other threads are only read while the thread has no findings of its own.
 */
export function useReviewFindingsSource(threadRef: ScopedThreadRef): {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly projectId: ProjectId | null;
  readonly running: RunningReview | null;
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
    hasOwnFindings || shell === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          pullRequests,
          checkout:
            pullRequests.length === 0
              ? {
                  projectId: shell.projectId,
                  branch: shell.branch,
                  worktreePath: shell.worktreePath,
                }
              : null,
        },
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
  const { posted, ratings } = useFindingRecords(source, sourceActivities);
  const currentNumber = resolveThreadCurrentPullRequestLink(pullRequests)?.number;
  const runningTarget = useMemo<ReviewThreadTarget>(
    () =>
      currentNumber === undefined
        ? { kind: "local" }
        : { kind: "pull-request", number: currentNumber },
    [currentNumber],
  );
  // The thread may itself be the review under way.
  const selfRunning = shell !== null && reviewTurnInFlight(shell);
  const runningCandidates = useMemo(
    () =>
      shell === null || !selfRunning
        ? linkedThreads
        : [
            ...linkedThreads,
            {
              id: shell.id,
              title: shell.title,
              createdAt: shell.createdAt,
              modelSelection: shell.modelSelection,
              running: true,
              activities,
            },
          ],
    [activities, linkedThreads, selfRunning, shell],
  );
  const running = useRunningReview(runningTarget, runningCandidates);
  return { source, posted, ratings, pullRequests, projectId: shell?.projectId ?? null, running };
}

export interface PullRequestReview {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  readonly running: RunningReview | null;
  /** How many of the findings are still to act on (`openReviewFindingCount`). */
  readonly openCount: number;
}

const NO_DISMISSED: Readonly<Record<string, true>> = {};

/**
 * What the pull request page shows of agent reviews of one pull request: the newest findings any
 * linked thread submitted about it, which of them were posted or are still open, and a review
 * still under way. Nothing for a pull request no thread can be linked to (a null key).
 */
export function usePullRequestReviewFindings(
  environmentId: EnvironmentId,
  pullRequest: ThreadPullRequestKey | null,
): PullRequestReview {
  const pullRequests = useMemo(() => (pullRequest === null ? [] : [pullRequest]), [pullRequest]);
  const linkedThreads = useLinkedReviewThreads(
    pullRequest === null ? null : { environmentId, threadId: null, pullRequests },
  );
  const source = useMemo(
    () => selectPullRequestReviewFindings({ pullRequests, threads: linkedThreads }),
    [linkedThreads, pullRequests],
  );
  const runningTarget = useMemo<ReviewThreadTarget | null>(
    () => (pullRequest === null ? null : { kind: "pull-request", number: pullRequest.number }),
    [pullRequest],
  );
  const running = useRunningReview(runningTarget, linkedThreads);
  const sourceActivities =
    source === null
      ? NO_ACTIVITIES
      : (linkedThreads.find((thread) => thread.id === source.threadId)?.activities ??
        NO_ACTIVITIES);
  const { posted, ratings } = useFindingRecords(source, sourceActivities);
  const dismissed = useReviewFixSentStore((state) =>
    source === null
      ? NO_DISMISSED
      : (state.dismissedByCard[reviewFindingsCardKey(environmentId, source.activityId)] ??
        NO_DISMISSED),
  );
  const openCount =
    source === null ? 0 : openReviewFindingCount(source.findings, dismissed, posted);
  return { source, posted, ratings, running, openCount };
}
