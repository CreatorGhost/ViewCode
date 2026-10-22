import type {
  EnvironmentId,
  ProjectId,
  ReviewFindingRating,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  agentReviewTargetChoices,
  agentReviewTargetKey,
  agentReviewTargetLabel,
  agentReviewTargetRequest,
  OTHER_REVIEWABLE_PULL_REQUEST_LIMIT,
  type ReviewablePullRequest,
} from "@t3tools/client-runtime/agent-review";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ReviewFindingsSource } from "@t3tools/client-runtime/review-findings";
import type { PostedReviewFinding } from "@t3tools/shared/reviewFindings";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { ListChecksIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";

import { useServerConfigs, useThreadShell } from "../../state/entities";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { announceReviewStarted } from "../pullRequest/PullRequestAgentReviewDialog";
import { ThreadPrFlowCard } from "./prFlow/ThreadPrFlowCard";
import { ReviewChangeView } from "./ReviewChangeView";
import { ReviewFindingsView, type ReviewFixInChat } from "./ReviewFindingsView";
import { ReviewStatusBar } from "./ReviewProgress";
import {
  type ReviewStartChoice,
  ReviewStartForm,
  type ReviewStartTarget,
  useReviewRetry,
} from "./ReviewStart";
import type { ReviewDiffTarget } from "./useReviewDiff";
import { type LatestReviewStatus, useReviewFindingsSource } from "./useReviewFindingsSource";

/** Enough of the project's open pull requests to fill the "Review" menu after the chat's own. */
const OPEN_PULL_REQUEST_LIMIT = 20;

/**
 * What a review started from a chat can read: its pull request, its changes, or another of the
 * project's open pull requests (`agentReviewTargetChoices`). The open ones are read only while the
 * Review panel is open.
 */
function useReviewStartChoices(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ScopedThreadRef["threadId"];
  readonly projectId: ProjectId | null;
  readonly own: ReviewablePullRequest | null;
  readonly canReviewPullRequest: boolean;
  readonly canReviewLocal: boolean;
}): ReadonlyArray<ReviewStartChoice> {
  const { environmentId, threadId, projectId, own, canReviewPullRequest, canReviewLocal } = input;
  const listed = useEnvironmentQuery(
    canReviewPullRequest && projectId !== null
      ? pullRequestEnvironment.list({
          environmentId,
          input: { projectId, state: "open", limit: OPEN_PULL_REQUEST_LIMIT },
        })
      : null,
  );
  // Its own read, so a request on an older pull request is not lost past the newest ones.
  const requestedListed = useEnvironmentQuery(
    canReviewPullRequest && projectId !== null
      ? pullRequestEnvironment.list({
          environmentId,
          input: {
            projectId,
            state: "open",
            involvement: "reviewing",
            limit: OTHER_REVIEWABLE_PULL_REQUEST_LIMIT,
          },
        })
      : null,
  );
  const entries = listed.data?.entries;
  const requestedEntries = requestedListed.data?.entries;
  return (() => {
    if (projectId === null) return [];
    const reviewable = (list: typeof entries) =>
      (list ?? [])
        .filter((entry) => entry.state === "open" && entry.projectId === projectId)
        .map(({ host, repository, number, title }) => ({ host, repository, number, title }));
    return agentReviewTargetChoices({
      pullRequest: canReviewPullRequest ? own : null,
      openPullRequests: reviewable(entries),
      // Only rows that say so: hosts without a reviewer filter answer every open one.
      reviewRequested: reviewable(requestedEntries?.filter((entry) => entry.viewerReviewRequested)),
      // The form's own "What to review" says what of the local changes to read.
      dirty: null,
      branch: null,
      canReviewLocal,
      canScope: false,
    }).map((target) => ({
      key: agentReviewTargetKey(target),
      label: target.kind === "local" ? "This chat's changes" : agentReviewTargetLabel(target),
      group:
        target.kind === "pull-request" && !target.own
          ? target.requested
            ? "requested"
            : "open"
          : "chat",
      request: agentReviewTargetRequest(target, { projectId, threadId }),
    }));
  })();
}

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
  const readerScrolled = () => scrolled.current.review === reviewKey && scrolled.current.scrolled;
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
          key={review.threadId}
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
  const ownTitle = pullRequest?.snapshot?.title ?? null;
  const own = (() =>
    host !== undefined && repository !== undefined && number !== undefined
      ? { host, repository, number, title: ownTitle }
      : null)();
  const choices = useReviewStartChoices({
    environmentId,
    threadId,
    projectId,
    own,
    canReviewPullRequest,
    canReviewLocal,
  });
  // Started here, the reviewer is this thread's child agent: the reader stays in this chat,
  // which shows the review among its agents while this panel shows the change and findings.
  const startReview = ((): ReviewStartTarget | null => {
    const first = choices[0];
    if (first === undefined) return null;
    return {
      environmentId,
      request: first.request,
      choices,
      onStarted: (started) => announceReviewStarted(started, "chat"),
    };
  })();
  // While a review that has sent no findings runs, the change it reads: the pull request its
  // thread is linked to, which may be another of the project's than this chat's.
  const reviewer = useThreadShell(
    review === null ? null : scopeThreadRef(environmentId, review.threadId),
  );
  const reviewed = (() =>
    review?.scope === null
      ? resolveThreadCurrentPullRequestLink(visibleThreadPullRequests(reviewer?.pullRequests ?? []))
      : null)();
  const change = ((): ReviewDiffTarget => {
    const target = reviewed ?? own;
    return target === null
      ? { kind: "local" }
      : {
          kind: "pull-request",
          host: target.host,
          repository: target.repository,
          number: target.number,
        };
  })();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pt-3 empty:hidden">
        <ThreadPrFlowCard threadRef={threadRef} />
      </div>
      <div className="min-h-0 flex-1">
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
                    ? `Have an agent review PR #${startReview.request.reference.number}. Findings appear here as it finds them.`
                    : startReview?.request.kind === "local"
                      ? "Have an agent review this chat's changes. Findings appear here as it finds them."
                      : "Link a pull request to this chat to have an agent review it here."}
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
      </div>
    </div>
  );
}
