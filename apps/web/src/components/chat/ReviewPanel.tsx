import type { PullRequestStartReviewResult, ScopedThreadRef } from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { Link, useNavigate } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useServerConfigs } from "../../state/entities";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { toastManager } from "../ui/toast";
import { ReviewFindingsView, type ReviewFixInChatRequest } from "./ReviewFindingsView";
import { ReviewStartForm, type ReviewStartTarget } from "./ReviewStart";
import { useReviewFindingsSource } from "./useReviewFindingsSource";

/**
 * The Review surface of the right panel: the latest findings for this thread (its own, or those
 * of the newest review of its pull request) over the change they are about. Findings for fixing
 * go to this thread's composer (`onFixInChat`); findings for somebody else's pull request are
 * posted to it as review comments.
 */
export function ReviewPanel({
  threadRef,
  cwd,
  onFixInChat,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's checkout: where a local review's change is read, and file links resolve. */
  cwd: string | undefined;
  onFixInChat?: ((request: ReviewFixInChatRequest) => void) | undefined;
}) {
  const { source, posted, pullRequests, projectId } = useReviewFindingsSource(threadRef);
  const navigate = useNavigate();
  const { environmentId } = threadRef;
  const canStartReview =
    useServerConfigs().get(environmentId)?.environment.capabilities.pullRequestAgentReview === true;
  // A review started from here keeps this thread open; its findings arrive here once it
  // submits them, since it is linked to the same pull request.
  const [started, setStarted] = useState<PullRequestStartReviewResult | null>(null);
  const pullRequest = resolveThreadCurrentPullRequestLink(pullRequests);
  const host = pullRequest?.host;
  const repository = pullRequest?.repository;
  const number = pullRequest?.number;
  const startReview = useMemo<ReviewStartTarget | null>(
    () =>
      canStartReview &&
      projectId !== null &&
      host !== undefined &&
      repository !== undefined &&
      number !== undefined
        ? {
            environmentId,
            reference: { projectId, host, repository, number },
            onStarted: (review) => {
              setStarted(review);
              toastManager.add({
                type: "success",
                title: "Review started",
                description: "Its findings appear in this panel when it is done.",
                actionProps: {
                  children: "Open review",
                  onClick: () => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: review.threadId },
                    });
                  },
                },
              });
            },
          }
        : null,
    [canStartReview, environmentId, host, navigate, number, projectId, repository],
  );
  if (source === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon />
          </EmptyMedia>
          <EmptyTitle>No review findings yet</EmptyTitle>
          <EmptyDescription>
            {started !== null ? (
              <>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: started.threadId }}
                  className="text-foreground hover:underline"
                >
                  {started.title}
                </Link>{" "}
                is under way. Its findings appear here when it is done.
              </>
            ) : startReview !== null ? (
              `Have an agent review PR #${startReview.reference.number}; its findings appear here.`
            ) : (
              "Link a pull request to this thread to have an agent review it here."
            )}
          </EmptyDescription>
        </EmptyHeader>
        {startReview !== null && started === null ? (
          <EmptyContent>
            <ReviewStartForm target={startReview} />
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  return (
    // A re-review starts fresh rather than keeping the previous set's view.
    <ReviewFindingsView
      key={`${source.threadId}:${source.activityId}`}
      environmentId={environmentId}
      threadRef={threadRef}
      source={source}
      projectId={projectId}
      cwd={cwd}
      posted={posted}
      onFixInChat={onFixInChat}
      startReview={startReview}
    />
  );
}
