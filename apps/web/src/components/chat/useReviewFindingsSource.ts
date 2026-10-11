import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { type PostedReviewFinding, postedReviewFindings } from "@t3tools/shared/reviewFindings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import {
  latestReviewFindingsActivity,
  reviewSourceCandidates,
  type ReviewFindingsSource,
  selectReviewFindingsSource,
} from "./reviewPanel.logic";

type ReviewActivities = ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>>;

const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NO_REVIEW_ACTIVITIES: ReviewActivities = [];
const NO_REVIEW_ACTIVITIES_ATOM = Atom.make(NO_REVIEW_ACTIVITIES).pipe(
  Atom.withLabel("web-review-activities:empty"),
);
const NO_POSTED: ReadonlyMap<string, PostedReviewFinding> = new Map();

function isReviewActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND ||
    activity.kind === REVIEW_FINDINGS_POSTED_ACTIVITY_KIND
  );
}

/**
 * Each listed thread's review activities: its findings, and what was posted from them. Reading a
 * thread's activities subscribes to it, so this only lives while a Review panel needs it; and it
 * settles on the same arrays until one of those activities changes, so a linked thread's ordinary
 * work does not re-render the panel.
 */
const reviewActivitiesAtomFamily = Atom.family((keys: string) => {
  const refs = keys.split("\n").flatMap((key) => parseScopedThreadKey(key) ?? []);
  let previous: ReviewActivities = NO_REVIEW_ACTIVITIES;
  return Atom.make((get) => {
    const next = refs.map((ref, index) => {
      const filtered = get(environmentThreadDetails.activitiesAtom(ref)).filter(isReviewActivity);
      const before = previous[index];
      return before !== undefined && arrayElementsEqual(before, filtered) ? before : filtered;
    });
    if (arrayElementsEqual(next, previous)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-review-activities:${keys}`));
});

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
  const shells = useThreadShells();
  const pullRequests = useMemo(
    () => visibleThreadPullRequests(shell?.pullRequests ?? []),
    [shell?.pullRequests],
  );
  const hasOwnFindings = latestReviewFindingsActivity(activities) !== undefined;
  const candidates = useMemo(
    () =>
      hasOwnFindings
        ? []
        : reviewSourceCandidates({
            threadId: threadRef.threadId,
            pullRequests,
            threads: shells.filter((entry) => entry.environmentId === threadRef.environmentId),
          }),
    [hasOwnFindings, pullRequests, shells, threadRef],
  );
  const candidateKeys = candidates
    .map((candidate) => scopedThreadKey(scopeThreadRef(threadRef.environmentId, candidate.id)))
    .join("\n");
  const linkedActivities = useAtomValue(
    candidateKeys === "" ? NO_REVIEW_ACTIVITIES_ATOM : reviewActivitiesAtomFamily(candidateKeys),
  );
  const title = shell?.title ?? "";
  const source = useMemo(
    () =>
      selectReviewFindingsSource({
        thread: { id: threadRef.threadId, title, activities },
        pullRequests,
        linkedThreads: candidates.map((candidate, index) => ({
          id: candidate.id,
          title: candidate.title,
          activities: linkedActivities[index] ?? NO_ACTIVITIES,
        })),
      }),
    [activities, candidates, linkedActivities, pullRequests, threadRef.threadId, title],
  );
  const sourceActivities =
    source === null
      ? NO_ACTIVITIES
      : source.threadId === threadRef.threadId
        ? activities
        : (linkedActivities[
            candidates.findIndex((candidate) => candidate.id === source.threadId)
          ] ?? NO_ACTIVITIES);
  const sourceActivityId = source?.activityId ?? null;
  const posted = useMemo(
    () =>
      sourceActivityId === null
        ? NO_POSTED
        : postedReviewFindings(sourceActivities, sourceActivityId),
    [sourceActivities, sourceActivityId],
  );
  return { source, posted, pullRequests, projectId: shell?.projectId ?? null };
}
