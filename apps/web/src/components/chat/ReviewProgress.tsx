import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectChildAgents,
  resolveSpawnedAgentRowStatus,
  SPAWNED_AGENT_STATUS_LABEL,
} from "@t3tools/client-runtime/state/child-agents";
import { AGENT_REVIEW_MODES, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { Button } from "../ui/button";
import { formatReviewElapsed, reviewWorkLine, shortReviewError } from "./reviewProgress.logic";
import type { LatestReviewStatus } from "./useReviewFindingsSource";

/** "Deep review · GPT-6.1": the kind of review and the model it runs on. */
export function useReviewLabel(environmentId: EnvironmentId, review: LatestReviewStatus): string {
  const { instanceId, model: slug } = review.modelSelection;
  const provider = useServerConfigs()
    .get(environmentId)
    ?.providers.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === slug);
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === review.mode)?.label ?? "Review";
  return `${mode} · ${model?.shortName ?? model?.name ?? slug}`;
}

/**
 * Where the latest review stands, above whatever the panel shows: while it runs, how long, its
 * current step and the agents it started; once it stopped without its final findings, why, with
 * Try again for a failure. Nothing for a review that is done. "View agent" opens the reviewer's
 * own chat, only when clicked.
 */
export function ReviewStatusBar({
  environmentId,
  review,
  newer,
  onRetry,
  retrying,
}: {
  environmentId: EnvironmentId;
  review: LatestReviewStatus;
  /** The findings below are an earlier review's. */
  newer: boolean;
  onRetry: (() => void) | null;
  retrying: boolean;
}) {
  const { progress } = review;
  const label = useReviewLabel(environmentId, review);
  const nowMinute = useNowMinute();
  const navigate = useNavigate();
  if (progress.kind === "done") return null;
  // The clock's minute is UTC ("YYYY-MM-DDTHH:MM"); it re-renders the bar once a minute.
  const elapsed = formatReviewElapsed(
    Date.parse(`${nowMinute}:00.000Z`) - Date.parse(review.startedAt),
  );
  const viewAgent = (
    <Button
      type="button"
      size="xs"
      variant="ghost-muted"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: review.threadId },
        })
      }
    >
      View agent
    </Button>
  );
  return (
    <div
      role="status"
      className="flex shrink-0 flex-col gap-0.5 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        {progress.kind === "running" ? (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-success motion-safe:animate-status-pulse"
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              progress.kind === "failed" ? "bg-destructive" : "bg-muted-foreground",
            )}
          />
        )}
        <span className={cn("min-w-0 truncate", progress.kind === "failed" && "text-destructive")}>
          {progress.kind === "running"
            ? `${newer ? "A new review is running" : "Reviewing…"} ${label} · ${elapsed}`
            : progress.kind === "failed"
              ? `${newer ? "A new review failed" : "Review failed"}: ${shortReviewError(progress.error)}`
              : progress.partial
                ? "The review ended before sending all its findings"
                : `${newer ? "A new review" : "The review"} ended without sending findings`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {viewAgent}
          {progress.kind === "failed" && onRetry !== null ? (
            <Button type="button" size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
              {retrying ? "Starting..." : "Try again"}
            </Button>
          ) : null}
        </span>
      </div>
      {progress.kind === "running" ? (
        <>
          <ReviewWorkLine environmentId={environmentId} threadId={review.threadId} />
          <ReviewAgentList environmentId={environmentId} threadId={review.threadId} />
        </>
      ) : null}
    </div>
  );
}

/** The reviewer's current step; reads only that thread's activities. */
export const ReviewWorkLine = memo(function ReviewWorkLine({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const line = useMemo(() => reviewWorkLine(activities ?? [], undefined), [activities]);
  return line === null ? null : <span className="min-w-0 truncate ps-3.5">{line}</span>;
});

/** The agents the reviewer started (a deep review's lenses), each with where it stands. */
export const ReviewAgentList = memo(function ReviewAgentList({
  environmentId,
  threadId,
  className,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  className?: string;
}) {
  const threads = useThreadShells();
  const agents = useMemo(
    () =>
      collectChildAgents(threads, { environmentId, threadId }).map((agent) => ({
        id: agent.thread.id,
        name: agent.thread.title,
        status: resolveSpawnedAgentRowStatus(agent.thread, "started"),
      })),
    [environmentId, threadId, threads],
  );
  if (agents.length === 0) return null;
  return (
    <ul className={cn("flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 ps-3.5", className)}>
      {agents.map((agent) => (
        <li key={agent.id} className="flex min-w-0 max-w-full items-center gap-1">
          <span className="truncate text-foreground">{agent.name}</span>
          {agent.status !== null ? (
            <span
              className={cn(
                "shrink-0",
                agent.status === "failed" && "text-destructive",
                agent.status === "running" && "text-success",
              )}
            >
              · {SPAWNED_AGENT_STATUS_LABEL[agent.status].toLowerCase()}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
});
