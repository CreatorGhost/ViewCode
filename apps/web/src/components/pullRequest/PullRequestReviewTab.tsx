import {
  AGENT_REVIEW_MODES,
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestStartReviewResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import { useServerConfigs } from "../../state/entities";
import { ReviewFindingsView } from "../chat/ReviewFindingsView";
import { ReviewStartForm, type ReviewStartTarget } from "../chat/ReviewStart";
import type { PullRequestReview, RunningPullRequestReview } from "../chat/useReviewFindingsSource";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

/** "Reviewing… Deep review · Opus 5.5", and the way to the review's chat. */
function RunningReviewStatus({
  environmentId,
  running,
  label,
}: {
  environmentId: EnvironmentId;
  running: RunningPullRequestReview;
  label: string;
}) {
  const { instanceId, model: slug } = running.modelSelection;
  const provider = useServerConfigs()
    .get(environmentId)
    ?.providers.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === slug);
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === running.mode)?.label ?? "Review";
  return (
    <p
      role="status"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs"
    >
      <span className="min-w-0 truncate">
        {label} {mode} · {model?.shortName ?? model?.name ?? slug}
      </span>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: running.threadId }}
        className="ml-auto shrink-0 text-foreground hover:underline"
      >
        Open chat
      </Link>
    </p>
  );
}

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
  const { source, posted, running } = review;
  const startReview = useMemo<ReviewStartTarget | null>(
    () => (canStart ? { environmentId, reference, onStarted } : null),
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
