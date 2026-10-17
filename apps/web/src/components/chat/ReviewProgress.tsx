import { useAtomValue } from "@effect/atom-react";
import {
  formatReviewDuration,
  formatReviewElapsed,
  reviewStatusText,
  reviewStopPlan,
} from "@t3tools/client-runtime/agent-review";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectChildAgents,
  resolveSpawnedAgentRowStatus,
  SPAWNED_AGENT_STATUS_LABEL,
} from "@t3tools/client-runtime/state/child-agents";
import { AGENT_REVIEW_MODES, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { readThreadShells } from "../../state/entities";
import { scopeThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import { useViewCodeThreadShells as useThreadShells } from "../../state/viewcodeThreadShells";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentThread } from "../../state/threads";
import * as Option from "effect/Option";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { useAgentControlActions } from "../agents/useAgentControlActions";
import { environmentThreadDetails } from "../../state/threads";
import { Button } from "../ui/button";
import { reviewWorkLine } from "./reviewProgress.logic";
import type { LatestReviewStatus } from "./useReviewFindingsSource";

/**
 * How long a review has run, by the shared minute clock, so the panel and the chat say the same
 * thing: until `endMs` once it stopped, else until now.
 */
export function useReviewElapsedMs(startedAt: string, endMs: number | null): number {
  const nowMinute = useNowMinute();
  // The clock's minute is UTC ("YYYY-MM-DDTHH:MM"); it re-renders its readers once a minute.
  const now = endMs ?? Date.parse(`${nowMinute}:00.000Z`);
  return now - Date.parse(startedAt);
}

/**
 * The review's time in the status bar's words: how long it has run ("6 min") while it runs, how
 * long it took ("took 19s") once it is over (`endMs`).
 */
export function ReviewElapsed({ startedAt, endMs }: { startedAt: string; endMs: number | null }) {
  const elapsedMs = useReviewElapsedMs(startedAt, endMs);
  return (
    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
      {endMs === null ? formatReviewElapsed(elapsedMs) : formatReviewDuration(elapsedMs)}
    </span>
  );
}

/** "Deep review · GPT-6.1": the kind of review and the model it runs on. */
export function useReviewLabel(environmentId: EnvironmentId, review: LatestReviewStatus): string {
  const { instanceId, model: slug } = review.modelSelection;
  const provider = useEnvironmentProviders()
    .get(environmentId)
    ?.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === slug);
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === review.mode)?.label ?? "Review";
  return `${mode} · ${model?.shortName ?? model?.name ?? slug}`;
}

/**
 * Where the latest review stands, above whatever the panel shows: while it runs, how long, its
 * current step and the agents it started, with Stop; once it stopped without its final findings,
 * why, with Try again. Nothing for a review that is done. "View agent" opens the reviewer's own
 * chat, only when clicked.
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
  const elapsedMs = useReviewElapsedMs(review.startedAt, null);
  const navigate = useNavigate();
  const actions = useAgentControlActions();
  const [stopping, setStopping] = useState(false);
  // Stops the reviewer and its agents for good (`reviewStopPlan`), and nothing else: the chat it
  // belongs to is in the same agent tree, so this never acts on the tree as a whole.
  const stopReview = async () => {
    setStopping(true);
    const plan = reviewStopPlan(readThreadShells().map((thread) => scopeThreadShell(thread.environmentId, thread.source)), { environmentId, threadId: review.threadId });
    for (const threadId of plan.stop) {
      await actions.stop(scopeThreadRef(environmentId, threadId), "thread");
    }
    for (const threadId of plan.discard) {
      await actions.discard(scopeThreadRef(environmentId, threadId), "thread");
    }
    setStopping(false);
  };
  if (progress.kind === "done") return null;
  const durationMs =
    review.endedAt === null ? null : Date.parse(review.endedAt) - Date.parse(review.startedAt);
  const text = reviewStatusText({ progress, label, elapsedMs, durationMs, newer });
  const running = progress.kind === "running";
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
      className={cn(
        "relative flex shrink-0 flex-col gap-0.5 border-b border-border/60 px-3 text-muted-foreground text-xs",
        running ? "bg-success/5 py-2.5" : "py-1.5",
      )}
    >
      <div className={cn("flex min-w-0 items-center", running ? "gap-2.5" : "gap-2")}>
        {running ? (
          // A spinning ring, unmissable at a glance, where a pulsing dot was easy to miss.
          <span
            aria-hidden
            className="size-5 shrink-0 rounded-full border-2 border-success/20 border-t-success motion-safe:animate-review-ring"
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
        {running ? (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-foreground text-sm">
              {newer ? "A new review is running" : review.title}
            </span>
            <span className="truncate">
              {label} · {formatReviewElapsed(elapsedMs)}
            </span>
          </span>
        ) : (
          <span
            className={cn("min-w-0 truncate", progress.kind === "failed" && "text-destructive")}
          >
            {text}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {viewAgent}
          {progress.kind === "running" ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={stopping}
              onClick={() => void stopReview()}
            >
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          ) : onRetry !== null ? (
            <Button type="button" size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
              {retrying ? "Starting..." : "Try again"}
            </Button>
          ) : null}
        </span>
      </div>
      {running ? (
        <>
          {/* Under the title: their own inset plus this much clears the ring. */}
          <div className="flex min-w-0 flex-col gap-0.5 ps-4">
            <ReviewWorkLine environmentId={environmentId} threadId={review.threadId} />
            <ReviewAgentList environmentId={environmentId} threadId={review.threadId} />
          </div>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
          >
            <span className="absolute inset-y-0 left-0 w-1/4 bg-linear-to-r from-transparent via-success to-transparent motion-safe:animate-review-sweep motion-reduce:hidden" />
          </span>
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
  const ref = scopeThreadRef(environmentId, threadId);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const projection = Option.getOrNull(useEnvironmentThread(environmentId, threadId).data);
  const entries = projection === null ? [] : deriveTimelineEntriesFromVisibleTurnItems({visibleTurnItems:projection.visibleTurnItems,optimisticMessages:[],attempts:projection.attempts,nodes:projection.nodes,plans:projection.plans}).flatMap((row) => row.kind === "work" ? [row.entry] : []);
  const line = reviewWorkLine(activities ?? [], undefined, entries);
  return line === null ? null : <span className="min-w-0 truncate ps-3.5">{line}</span>;
});

const COLLAPSED_AGENT_LIMIT = 3;

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
  const agents = collectChildAgents(threads, { environmentId, threadId }).map((agent) => ({
        id: agent.thread.id,
        name: agent.thread.title,
        status: resolveSpawnedAgentRowStatus(agent.thread, "started"),
      }));
  const [expanded, setExpanded] = useState(false);
  if (agents.length === 0) return null;
  // A deep review starts many lenses; past a few, one line counts them until asked for the list.
  if (agents.length > COLLAPSED_AGENT_LIMIT && !expanded) {
    const running = agents.filter((agent) => agent.status === "running").length;
    return (
      <div className={cn("flex min-w-0 items-center gap-2 ps-3.5", className)}>
        <span className="truncate">
          {agents.length} agents{running > 0 ? ` · ${running} running` : ""}
        </span>
        <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded(true)}>
          Show
        </Button>
      </div>
    );
  }
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
