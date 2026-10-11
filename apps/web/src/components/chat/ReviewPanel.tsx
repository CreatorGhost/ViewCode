import type {
  EnvironmentId,
  ProjectId,
  ReviewFindingRating,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReviewFindingsSource } from "@t3tools/client-runtime/review-findings";
import type { PostedReviewFinding } from "@t3tools/shared/reviewFindings";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { ListChecksIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef } from "react";

import { useServerConfigs } from "../../state/entities";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { announceReviewStarted } from "../pullRequest/PullRequestAgentReviewDialog";
import { ReviewChangeView } from "./ReviewChangeView";
import { ReviewFindingsView, type ReviewFixInChat } from "./ReviewFindingsView";
import { ReviewStatusBar } from "./ReviewProgress";
import { ReviewStartForm, type ReviewStartTarget, useReviewRetry } from "./ReviewStart";
import type { ReviewDiffTarget } from "./useReviewDiff";
import { type LatestReviewStatus, useReviewFindingsSource } from "./useReviewFindingsSource";

const SCROLL_KEYS = new Set(["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "]);

/**
 * What a review view shows, in a thread's Review panel or on the pull request page: where the
 * latest review stands, above its findings over the change they are about, or while it has sent
 * none yet the change itself, or with no review at all `empty`.
 */
export function ReviewSurface({
  environmentId,
  threadRef,
  source,
  posted,
  ratings,
  review,
  projectId,
  cwd,
  change,
  startReview,
  onFixInChat,
  empty,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  source: ReviewFindingsSource | null;
  posted: ReadonlyMap<string, PostedReviewFinding>;
  ratings: ReadonlyMap<string, ReviewFindingRating>;
  review: LatestReviewStatus | null;
  projectId: ProjectId | null;
  cwd: string | undefined;
  /** What a new review reads, shown while one runs without findings yet. */
  change: ReviewDiffTarget | null;
  startReview: ReviewStartTarget | null;
  onFixInChat: ReviewFixInChat | undefined;
  empty: ReactNode;
}) {
  const { retry, pending } = useReviewRetry(startReview, review);
  const progress = review?.progress ?? null;
  // The findings below are this review's own, sent while it still works.
  const ownFindings = source !== null && review !== null && source.threadId === review.threadId;
  // Whether the reader scrolled during this review, in the change or its findings: the first
  // findings to arrive then do not pull them away from where they are reading.
  const scrolled = useRef<{ readonly review: string | null; scrolled: boolean }>({
    review: null,
    scrolled: false,
  });
  const reviewKey = source?.threadId ?? review?.threadId ?? null;
  const readerScrolled = useCallback(
    () => scrolled.current.review === reviewKey && scrolled.current.scrolled,
    [reviewKey],
  );
  const noteScroll = () => {
    scrolled.current = { review: reviewKey, scrolled: true };
  };
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onWheelCapture={noteScroll}
      onTouchMoveCapture={noteScroll}
      onKeyDownCapture={(event) => {
        if (SCROLL_KEYS.has(event.key)) noteScroll();
      }}
    >
      {review !== null ? (
        <ReviewStatusBar
          environmentId={environmentId}
          review={review}
          newer={source !== null && !ownFindings}
          onRetry={retry}
          retrying={pending}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        {source !== null ? (
          // Keyed by review rather than by set, so findings arriving as the review goes on fill
          // the same view instead of resetting where the reader is.
          <ReviewFindingsView
            key={source.threadId}
            environmentId={environmentId}
            threadRef={threadRef}
            source={source}
            projectId={projectId}
            cwd={cwd}
            posted={posted}
            ratings={ratings}
            onFixInChat={onFixInChat}
            startReview={startReview}
            stillReviewing={ownFindings && progress?.kind === "running"}
            readerScrolled={readerScrolled}
          />
        ) : progress?.kind === "running" && change !== null ? (
          <ReviewChangeView
            environmentId={environmentId}
            target={change}
            scope={change.kind === "local" ? (review?.scope ?? null) : null}
            projectId={projectId}
            cwd={cwd}
          />
        ) : (
          <div className="h-full overflow-y-auto">{empty}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The Review surface of the right panel: the latest review of this thread (one started from it
 * runs as its child agent; or the newest review of its pull request) and its findings over the
 * change they are about. Findings for fixing are sent into this chat as the reader's message;
 * findings for somebody else's pull request are posted to it as review comments.
 */
export function ReviewPanel({
  threadRef,
  cwd,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's checkout: where a local review's change is read, and file links resolve. */
  cwd: string | undefined;
}) {
  const { source, posted, ratings, pullRequests, projectId, review } =
    useReviewFindingsSource(threadRef);
  const { environmentId, threadId } = threadRef;
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const canReviewPullRequest = capabilities?.pullRequestAgentReview === true;
  const canReviewLocal = capabilities?.localAgentReview === true;
  const pullRequest = resolveThreadCurrentPullRequestLink(pullRequests);
  const host = pullRequest?.host;
  const repository = pullRequest?.repository;
  const number = pullRequest?.number;
  // Started here, the reviewer is this thread's child agent: the reader stays in this chat,
  // which shows the review among its agents while this panel shows the change and findings.
  const startReview = useMemo<ReviewStartTarget | null>(() => {
    if (projectId === null) return null;
    const onStarted = (started: Parameters<ReviewStartTarget["onStarted"]>[0]) =>
      announceReviewStarted(started, "chat");
    if (host !== undefined && repository !== undefined && number !== undefined) {
      return canReviewPullRequest
        ? {
            environmentId,
            request: {
              kind: "pull-request",
              reference: { projectId, host, repository, number },
              sourceThreadId: threadId,
            },
            onStarted,
          }
        : null;
    }
    return canReviewLocal
      ? {
          environmentId,
          request: { kind: "local", projectId, sourceThreadId: threadId },
          onStarted,
        }
      : null;
  }, [
    canReviewLocal,
    canReviewPullRequest,
    environmentId,
    host,
    number,
    projectId,
    repository,
    threadId,
  ]);
  const change = useMemo<ReviewDiffTarget | null>(
    () =>
      host !== undefined && repository !== undefined && number !== undefined
        ? { kind: "pull-request", host, repository, number }
        : { kind: "local" },
    [host, number, repository],
  );
  return (
    <ReviewSurface
      environmentId={environmentId}
      threadRef={threadRef}
      source={source}
      posted={posted}
      ratings={ratings}
      review={review}
      projectId={projectId}
      cwd={cwd}
      change={change}
      startReview={startReview}
      onFixInChat={undefined}
      empty={
        <Empty size="compact">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecksIcon />
            </EmptyMedia>
            <EmptyTitle>No review findings yet</EmptyTitle>
            <EmptyDescription>
              {startReview?.request.kind === "pull-request"
                ? `Have an agent review PR #${startReview.request.reference.number}; its findings appear here as it finds them.`
                : startReview?.request.kind === "local"
                  ? "Have an agent review this thread's uncommitted changes, or its branch when everything is committed; its findings appear here as it finds them."
                  : "Link a pull request to this thread to have an agent review it here."}
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
