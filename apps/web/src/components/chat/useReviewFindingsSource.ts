import { useAtomValue } from "@effect/atom-react";
import {
  latestReviewFindingsActivity,
  openReviewFindingCount,
  type ReviewFindingsSource,
  selectPullRequestReviewFindings,
  selectReviewFindingsSource,
  selectRunningPullRequestReview,
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
  ScopedThreadRef,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { type PostedReviewFinding, postedReviewFindings } from "@t3tools/shared/reviewFindings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { reviewFindingsCardKey, useReviewFixSentStore } from "./reviewFixSentStore";

const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NO_POSTED: ReadonlyMap<string, PostedReviewFinding> = new Map();

const linkedReviewThreadsAtom = createLinkedReviewThreadsAtomFamily({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  activitiesAtom: environmentThreadDetails.activitiesAtom,
  label: "web-linked-reviews",
});

function useLinkedReviewThreads(key: LinkedReviewsKey | null): ReadonlyArray<LinkedReviewThread> {
  return useAtomValue(linkedReviewThreadsAtom(key));
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

export interface PullRequestReview {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly running: RunningPullRequestReview | null;
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
  const dismissed = useReviewFixSentStore((state) =>
    source === null
      ? NO_DISMISSED
      : (state.dismissedByCard[reviewFindingsCardKey(environmentId, source.activityId)] ??
        NO_DISMISSED),
  );
  const openCount =
    source === null ? 0 : openReviewFindingCount(source.findings, dismissed, posted);
  return { source, posted, running, openCount };
}
