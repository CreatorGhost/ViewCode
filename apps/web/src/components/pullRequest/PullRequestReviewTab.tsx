import {
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestStartReviewResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import { ReviewFindingsView } from "../chat/ReviewFindingsView";
import { ReviewStartForm, type ReviewStartTarget, RunningReviewStatus } from "../chat/ReviewStart";
import type { PullRequestReview } from "../chat/useReviewFindingsSource";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

/**
 * The pull request page's Review tab: the latest agent review of this pull request, in the same
 * view a thread's Review panel uses, with a review still under way said above it. With no review
 * yet, a new one starts here. Fixing picks a session, since no chat sits beside the page. Loaded
 * on demand, like the Code tab, since it carries the diff viewer.
 */
export default function PullRequestReviewTab({
  environmentId,
  reference,
  review,
  canStart,
  threadRef,
  cwd,
  onStarted,
}: {
  /** Where reviews run: the panel's acting server. */
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  review: PullRequestReview;
  canStart: boolean;
  threadRef: ScopedThreadRef | null;
  cwd: string | undefined;
  onStarted: (started: PullRequestStartReviewResult) => void;
}) {
  const { source, posted, ratings, running } = review;
  const startReview = useMemo<ReviewStartTarget | null>(
    () =>
      canStart ? { environmentId, request: { kind: "pull-request", reference }, onStarted } : null,
    [canStart, environmentId, onStarted, reference],
  );
  if (source !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {running !== null ? (
          <RunningReviewStatus
            environmentId={environmentId}
            running={running}
            label="A new review is running:"
          />
        ) : null}
        <div className="min-h-0 flex-1">
          {/* A re-review starts fresh rather than keeping the previous set's view. */}
          <ReviewFindingsView
            key={`${source.threadId}:${source.activityId}`}
            environmentId={environmentId}
            threadRef={threadRef}
            source={source}
            projectId={reference.projectId}
            cwd={cwd}
            posted={posted}
            ratings={ratings}
            onFixInChat={undefined}
            startReview={startReview}
          />
        </div>
      </div>
    );
  }
  if (running !== null) {
    return (
      <RunningReviewStatus environmentId={environmentId} running={running} label="Reviewing…" />
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon />
          </EmptyMedia>
          <EmptyTitle>No agent review yet</EmptyTitle>
          <EmptyDescription>
            {startReview !== null
              ? `Have an agent review PR #${reference.number}; its findings appear here.`
              : "Agent reviews are not available on this server."}
          </EmptyDescription>
        </EmptyHeader>
        {startReview !== null ? (
          <EmptyContent>
            <ReviewStartForm target={startReview} />
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}
