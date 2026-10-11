import type { EnvironmentId, PullRequestRef, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import { ReviewSurface } from "../chat/ReviewPanel";
import { ReviewStartForm, type ReviewStartTarget } from "../chat/ReviewStart";
import type { ReviewFixInChat } from "../chat/ReviewFindingsView";
import type { ReviewDiffTarget } from "../chat/useReviewDiff";
import type { PullRequestReview } from "../chat/useReviewFindingsSource";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import type { StartedAgentReview } from "./PullRequestAgentReviewDialog";

/**
 * The pull request page's Review tab: the latest agent review of this pull request, in the same
 * view a thread's Review panel uses. With no review yet, a new one starts here. Fixing goes to
 * the chat working on the pull request (`onFixInChat`). Loaded on demand, like the Code tab,
 * since it carries the diff viewer.
 */
export default function PullRequestReviewTab({
  environmentId,
  reference,
  sourceThreadId,
  review,
  canStart,
  threadRef,
  cwd,
  host,
  onStarted,
  onFixInChat,
}: {
  /** Where reviews run: the panel's acting server. */
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** The chat the detail sits beside, whose agent a review started here becomes. */
  sourceThreadId: ThreadId | undefined;
  review: PullRequestReview;
  canStart: boolean;
  threadRef: ScopedThreadRef | null;
  cwd: string | undefined;
  /** The pull request's host, for reading its change before any findings name it. */
  host: string | null;
  onStarted: (started: StartedAgentReview) => void;
  onFixInChat: ReviewFixInChat | undefined;
}) {
  const { source, posted, ratings } = review;
  const startReview = useMemo<ReviewStartTarget | null>(
    () =>
      canStart
        ? {
            environmentId,
            request: { kind: "pull-request", reference, sourceThreadId },
            onStarted,
          }
        : null,
    [canStart, environmentId, onStarted, reference, sourceThreadId],
  );
  const change = useMemo<ReviewDiffTarget | null>(
    () =>
      host === null
        ? null
        : {
            kind: "pull-request",
            host,
            repository: reference.repository,
            number: reference.number,
          },
    [host, reference.number, reference.repository],
  );
  return (
    <ReviewSurface
      environmentId={environmentId}
      threadRef={threadRef}
      source={source}
      posted={posted}
      ratings={ratings}
      review={review.review}
      projectId={reference.projectId}
      cwd={cwd}
      change={change}
      startReview={startReview}
      onFixInChat={onFixInChat}
      empty={
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecksIcon />
            </EmptyMedia>
            <EmptyTitle>No agent review yet</EmptyTitle>
            <EmptyDescription>
              {startReview !== null
                ? `Have an agent review PR #${reference.number}. Findings appear here as it finds them.`
                : "Agent reviews are not available on this server."}
            </EmptyDescription>
          </EmptyHeader>
          {startReview !== null ? (
            <EmptyContent>
              <ReviewStartForm target={startReview} />
            </EmptyContent>
          ) : null}
        </Empty>
      }
    />
  );
}
