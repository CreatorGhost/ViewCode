import { useAtomValue } from "@effect/atom-react";
import {
  latestReviewFindingsSource,
  reviewFindingEntries,
  type ReviewFindingEntry,
  type ReviewFindingsSource,
  reviewStartedRecord,
  type ReviewStartedRecord,
} from "@t3tools/client-runtime/review-findings";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationThreadActivity,
  ReviewFindingRating,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type PostedReviewFinding,
  postedReviewFindings,
  reviewFindingRatings,
} from "@t3tools/shared/reviewFindings";
import { useMemo } from "react";

import { useThreadShell } from "../../../state/entities";
import { environmentThreadDetails } from "../../../state/threads";

const NO_ENTRIES: ReadonlyArray<ReviewFindingEntry> = [];
const NO_POSTED: ReadonlyMap<string, PostedReviewFinding> = new Map();
const NO_RATINGS: ReadonlyMap<string, ReviewFindingRating> = new Map();

export interface ReviewThreadFindings {
  readonly shell: EnvironmentThreadShell | null;
  /** The thread's latest findings; a re-review's replace the earlier set. */
  readonly source: ReviewFindingsSource | null;
  readonly entries: ReadonlyArray<ReviewFindingEntry>;
  /** Which findings were posted to the pull request, from the thread's records. */
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  /** How each finding is rated now, from the thread's records. */
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  /** The thread has not loaded yet, so no findings may only mean not yet. */
  readonly loading: boolean;
  /** How the thread's review was asked for; null for a thread that is no review. */
  readonly started: ReviewStartedRecord | null;
  /** All of the thread's activities, for what else its record says (a provider error). */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * A review thread's latest findings and what was done with them on the server. Reading the
 * thread's activities subscribes to it, so a post or rating from any client shows here.
 */
export function useReviewThreadFindings(ref: ScopedThreadRef): ReviewThreadFindings {
  const shell = useThreadShell(ref);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const status = useAtomValue(environmentThreadDetails.statusAtom(ref));
  const title = shell?.title ?? "";
  const source = useMemo(
    () => latestReviewFindingsSource({ id: ref.threadId, title, activities }),
    [activities, ref.threadId, title],
  );
  const findings = source?.findings ?? null;
  const activityId = source?.activityId ?? null;
  const entries = useMemo(
    () => (findings === null ? NO_ENTRIES : reviewFindingEntries(findings)),
    [findings],
  );
  const posted = useMemo(
    () => (activityId === null ? NO_POSTED : postedReviewFindings(activities, activityId)),
    [activities, activityId],
  );
  const ratings = useMemo(
    () => (activityId === null ? NO_RATINGS : reviewFindingRatings(activities, activityId)),
    [activities, activityId],
  );
  return {
    shell,
    source,
    entries,
    posted,
    ratings,
    loading: source === null && status === "synchronizing",
    started: reviewStartedRecord(activities),
    activities,
  };
}
