import { useAtomValue } from "@effect/atom-react";
import {
  openReviewFindingCount,
  type ReviewFindingsSource,
  type ReviewProgress,
  selectLatestReview,
  selectPullRequestReviewFindings,
  selectReviewFindingsSource,
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
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
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

/** The latest review a view knows of and where it stands (see `selectLatestReview`). */
export interface LatestReviewStatus {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly mode: AgentReviewMode;
  readonly focus: string | null;
  readonly modelSelection: ModelSelection;
  readonly startedAt: string;
  readonly progress: ReviewProgress;
}

function useLatestReview(threads: ReadonlyArray<LinkedReviewThread>): LatestReviewStatus | null {
  const latest = useMemo(() => selectLatestReview(threads), [threads]);
  return useMemo(
    () =>
      latest === null
        ? null
        : {
            threadId: latest.thread.id,
            title: latest.thread.title,
            mode: latest.mode,
            focus: latest.focus,
            modelSelection: latest.thread.modelSelection,
            startedAt: latest.thread.createdAt,
            progress: latest.progress,
          },
    [latest],
  );
}

/**
 * The findings a thread's Review panel shows (see `selectReviewFindingsSource`), which of them
 * were posted to the pull request, the pull requests a new review of it would look at, and the
 * latest review of it: the thread itself, one of its child agents (reviews started from a chat
 * run as its children) or a thread linked to its pull requests.
 */
export function useReviewFindingsSource(threadRef: ScopedThreadRef): {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly projectId: ProjectId | null;
  readonly review: LatestReviewStatus | null;
} {
  const shell = useThreadShell(threadRef);
  const activities =
    useAtomValue(environmentThreadDetails.activitiesAtom(threadRef)) ?? NO_ACTIVITIES;
  const pullRequests = useMemo(
    () => visibleThreadPullRequests(shell?.pullRequests ?? []),
    [shell?.pullRequests],
  );
  const linkedThreads = useLinkedReviewThreads(
    shell === null
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
  const { posted, ratings } = useFindingRecords(source, sourceActivities);
  const review = useLatestReview(linkedThreads);
  return { source, posted, ratings, pullRequests, projectId: shell?.projectId ?? null, review };
}

export interface PullRequestReview {
  readonly source: ReviewFindingsSource | null;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  readonly review: LatestReviewStatus | null;
  /** How many of the findings are still to act on (`openReviewFindingCount`). */
  readonly openCount: number;
}

const NO_DISMISSED: Readonly<Record<string, true>> = {};

/**
 * What the pull request page shows of agent reviews of one pull request: the newest findings any
 * linked thread submitted about it, which of them were posted or are still open, and the latest
 * review of it. Nothing for a pull request no thread can be linked to (a null key).
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
  const review = useLatestReview(linkedThreads);
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
  return { source, posted, ratings, review, openCount };
}
