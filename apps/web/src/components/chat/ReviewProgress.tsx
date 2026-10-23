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
  resolveEffectiveAgentStatus,
  SPAWNED_AGENT_STATUS_LABEL,
  type SpawnedAgentRowStatus,
} from "@t3tools/client-runtime/state/child-agents";
import { AGENT_REVIEW_MODES, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, ListChecksIcon } from "lucide-react";
import { memo, type ReactNode, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { readThreadShells, useThreadShell } from "../../state/entities";
import { scopeThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import { useViewCodeThreadShells as useThreadShells } from "../../state/viewcodeThreadShells";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentThread } from "../../state/threads";
import * as Option from "effect/Option";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { useAgentControlActions } from "../agents/useAgentControlActions";
import { environmentThreadDetails } from "../../state/threads";
import { BlurSwap } from "../ui/blur-swap";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PrFlowRowFrame, ShimmerLabel } from "./prFlow/PrFlowCard";
import {
  type GraphNode,
  type GraphSegment,
  LANE_X,
  layoutGraph,
  ROW_HEIGHT,
} from "./prFlow/prFlowGraph";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { type ReviewHeading, ReviewIdentity, useLinkedPullRequestTitle } from "./reviewIdentity";
import { reviewWorkLine } from "./reviewProgress.logic";
import type { LatestReviewStatus } from "./useReviewFindingsSource";

/**
 * How long a review has run, by the shared minute clock, so the panel and the chat say the same
 * thing: until `endMs` once it stopped, else until now.
 */
function useReviewElapsedMs(startedAt: string, endMs: number | null): number {
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

/** The kind of review ("Deep review") and the model it runs on ("GPT-6.1"), with its provider. */
function useReviewParts(environmentId: EnvironmentId, review: LatestReviewStatus) {
  const { instanceId, model: slug } = review.modelSelection;
  const provider = useEnvironmentProviders()
    .get(environmentId)
    ?.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === slug);
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === review.mode)?.label ?? "Review";
  return { mode, model: model?.shortName ?? model?.name ?? slug, provider: provider ?? null };
}

export type ReviewAgent = {
  readonly id: ThreadId;
  readonly name: string;
  readonly status: SpawnedAgentRowStatus | null;
};

function useReviewAgents(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ReviewAgent> {
  const threads = useThreadShells();
  return collectChildAgents(threads, { environmentId, threadId }).map((agent) => ({
    id: agent.thread.id,
    name: agent.thread.title,
    status: resolveEffectiveAgentStatus(agent.thread, { record: agent.record }),
  }));
}

const AGENT_NODE_TONE: Record<SpawnedAgentRowStatus, string> = {
  running: "text-info",
  approval: "text-warning",
  input: "text-warning",
  failed: "text-destructive",
  stopped: "text-muted-foreground/60",
  done: "text-success",
  queued: "text-muted-foreground/60",
  idle: "text-muted-foreground/60",
};

const AGENT_TEXT_TONE: Partial<Record<SpawnedAgentRowStatus, string>> = {
  running: "text-info-foreground",
  failed: "text-destructive",
  done: "text-success-foreground",
  approval: "text-warning-foreground",
  input: "text-warning-foreground",
};

/**
 * Where the latest review stands, in the pull request card's language: a card with the kind of
 * review and its model, how long it has run, and, while it runs, the reviewer on a small graph
 * with its current step and the agents it started below it, each with where it stands. Stopped
 * without its final findings, the card says why, with Try again. Nothing for a review that is
 * done. "View agent" opens the reviewer's own chat, only when clicked.
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
  const { mode, model, provider } = useReviewParts(environmentId, review);
  // A review of a pull request runs in a thread linked to it; a local review has a scope.
  const reviewerShell = useThreadShell(scopeThreadRef(environmentId, review.threadId));
  const reviewedLink =
    review.scope === null
      ? resolveThreadCurrentPullRequestLink(
          visibleThreadPullRequests(reviewerShell?.pullRequests ?? []),
        )
      : null;
  const linkedTitle = useLinkedPullRequestTitle(
    environmentId,
    review.threadId,
    reviewedLink?.number ?? null,
  );
  const heading: ReviewHeading =
    reviewedLink === null
      ? { kind: "local" }
      : { kind: "pull-request", number: reviewedLink.number, title: linkedTitle };
  const navigate = useNavigate();
  const actions = useAgentControlActions();
  const [stopping, setStopping] = useState(false);
  // Stops the reviewer and its agents for good (`reviewStopPlan`), and nothing else: the chat it
  // belongs to is in the same agent tree, so this never acts on the tree as a whole.
  const stopReview = async () => {
    setStopping(true);
    const plan = reviewStopPlan(
      readThreadShells().map((thread) => scopeThreadShell(thread.environmentId, thread.source)),
      { environmentId, threadId: review.threadId },
    );
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
  const running = progress.kind === "running";
  return (
    <ReviewCard
      icon={
        provider ? (
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={provider.displayName ?? provider.instanceId}
            accentColor={provider.accentColor}
            className="size-4 shrink-0"
            iconClassName="size-4"
          />
        ) : null
      }
      kicker={
        running ? "Reviewing now" : progress.kind === "failed" ? "Review failed" : "Review ended"
      }
      kickerVariant={running ? "info" : progress.kind === "failed" ? "error" : "outline"}
      heading={heading}
      mode={mode}
      model={model}
      title={review.title}
      note={null}
      startedAt={review.startedAt}
      state={
        running
          ? { kind: "running" }
          : {
              kind: progress.kind,
              text:
                // The running sentence, the only one that reads the elapsed time, is not shown.
                reviewStatusText({
                  progress,
                  label: `${mode} · ${model}`,
                  elapsedMs: 0,
                  durationMs,
                  newer,
                }) ?? "",
            }
      }
      tree={
        <ThreadReviewTree
          key={review.threadId}
          environmentId={environmentId}
          threadId={review.threadId}
        />
      }
      onViewAgent={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: review.threadId },
        })
      }
      onStop={() => void stopReview()}
      stopping={stopping}
      onRetry={onRetry}
      retrying={retrying}
    />
  );
}

export type ReviewCardState =
  | { readonly kind: "running" }
  | { readonly kind: "failed" | "ended"; readonly text: string };

/** The review card drawn from what it shows; ReviewStatusBar reads the thread for it. */
export function ReviewCard({
  icon,
  kicker,
  kickerVariant,
  heading,
  mode,
  model,
  title,
  note,
  startedAt,
  state,
  tree,
  onViewAgent,
  onStop,
  stopping,
  onRetry,
  retrying,
}: {
  icon: ReactNode;
  /** What this block is, in two words: "Reviewing now", "Review failed". */
  kicker: string;
  kickerVariant: "info" | "error" | "outline";
  /** What the review reads. */
  heading: ReviewHeading;
  mode: string;
  model: string;
  /** The review's own name ("Deep review: #1615 …"), named by the View agent tooltip. */
  title: string;
  /** A line under the header, when the card has to say more than its state. */
  note: string | null;
  startedAt: string;
  state: ReviewCardState;
  /** The reviewer and its agents while the review runs (ReviewTree). */
  tree: ReactNode;
  onViewAgent: () => void;
  onStop: () => void;
  stopping: boolean;
  onRetry: (() => void) | null;
  retrying: boolean;
}) {
  const running = state.kind === "running";
  return (
    <div role="status" className="shrink-0 px-3 pt-2">
      <div className="blur-swap flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm">
        <div className="px-0.5">
          <ReviewIdentity
            kicker={kicker}
            kickerVariant={kickerVariant}
            heading={heading}
            trailing={
              <>
                {running ? <ReviewElapsed startedAt={startedAt} endMs={null} /> : null}
                <span className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="View agent"
                          onClick={onViewAgent}
                        />
                      }
                    >
                      <ArrowUpRightIcon aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Open the reviewer's chat: {title}</TooltipPopup>
                  </Tooltip>
                  {running ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={stopping}
                      onClick={onStop}
                    >
                      {stopping ? "Stopping..." : "Stop"}
                    </Button>
                  ) : onRetry !== null ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={retrying}
                      onClick={onRetry}
                    >
                      {retrying ? "Starting..." : "Try again"}
                    </Button>
                  ) : null}
                </span>
              </>
            }
          />
        </div>
        <div className="flex items-center gap-1.5 px-0.5 text-muted-foreground text-xs">
          {icon ?? <ListChecksIcon aria-hidden className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate">
            {mode} · {model}
          </span>
        </div>
        {note !== null ? <p className="px-0.5 text-muted-foreground text-xs">{note}</p> : null}
        {running ? (
          tree
        ) : (
          <p
            className={cn(
              "text-pretty px-0.5 text-xs",
              state.kind === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {state.text}
          </p>
        )}
      </div>
    </div>
  );
}

const COLLAPSED_AGENT_LIMIT = 3;

/**
 * The review as the pull request card draws a branch: the reviewer at the top with its current
 * step shining while it works, and under it, on a lane of their own, the agents it started (a
 * deep review's lenses) with where each stands. Agents arrive as rows opening in; past a few,
 * one row counts them until asked for the list.
 */
export function ReviewTree({
  step,
  agents,
}: {
  /** The reviewer's current step, as the top row's text. */
  step: ReactNode;
  agents: ReadonlyArray<ReviewAgent>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [initialIds] = useState(() => new Set(agents.map((agent) => agent.id)));
  const folded = agents.length > COLLAPSED_AGENT_LIMIT && !expanded;
  const shown = folded ? [] : agents;
  // The agents hang off the reviewer as merged-in branches: every one is an "incoming" parent
  // (never the first), so the edges all take the side lane's colour. The first parent names no
  // row and draws nothing.
  const nodes: ReadonlyArray<GraphNode> = [
    {
      key: "reviewer",
      sha: "reviewer",
      lane: "head",
      parents: ["", ...(folded ? ["folded"] : shown.map((agent) => agent.id))],
    },
    ...shown.map((agent): GraphNode => ({
      key: agent.id,
      sha: agent.id,
      lane: "side",
      parents: [],
    })),
    ...(folded ? [{ key: "folded", sha: "folded", lane: "side" as const, parents: [] }] : []),
  ];
  const segments = layoutGraph(nodes);
  const tone = (segment: GraphSegment) => (segment.lane === "head" ? "text-info" : "text-success");
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex flex-col">
      <PrFlowRowFrame
        index={0}
        segments={segments[0] ?? []}
        segmentTone={tone}
        node={
          <g className="text-info">
            <circle
              cx={LANE_X.head}
              cy={ROW_HEIGHT / 2}
              r={4.5}
              className="fill-card"
              stroke="currentColor"
              strokeWidth={1.5}
            />
            <circle cx={LANE_X.head} cy={ROW_HEIGHT / 2} r={1.6} fill="currentColor" />
          </g>
        }
      >
        {step}
      </PrFlowRowFrame>
      {shown.map((agent, index) => (
        <PrFlowRowFrame
          key={agent.id}
          index={index + 1}
          arriving={!initialIds.has(agent.id)}
          segments={segments[index + 1] ?? []}
          segmentTone={tone}
          node={
            <circle
              cx={LANE_X.side}
              cy={ROW_HEIGHT / 2}
              r={3.5}
              className={AGENT_NODE_TONE[agent.status ?? "idle"]}
              fill="currentColor"
            />
          }
        >
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          {agent.status !== null ? (
            <BlurSwap
              swapKey={agent.status}
              render={
                <span
                  className={cn(
                    "shrink-0 text-muted-foreground text-xs",
                    AGENT_TEXT_TONE[agent.status],
                  )}
                />
              }
            >
              {SPAWNED_AGENT_STATUS_LABEL[agent.status]}
            </BlurSwap>
          ) : null}
        </PrFlowRowFrame>
      ))}
      {folded ? (
        <PrFlowRowFrame
          index={1}
          segments={segments[1] ?? []}
          segmentTone={tone}
          node={
            <circle
              cx={LANE_X.side}
              cy={ROW_HEIGHT / 2}
              r={3.5}
              className="fill-card text-success"
              stroke="currentColor"
              strokeWidth={1.5}
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {agents.length} agents{running > 0 ? ` · ${running} running` : ""}
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={() => setExpanded(true)}>
            Show
          </Button>
        </PrFlowRowFrame>
      ) : null}
    </div>
  );
}

/** The tree read from the thread: only this re-renders as the agents' shells change. */
const ThreadReviewTree = memo(function ThreadReviewTree({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const agents = useReviewAgents(environmentId, threadId);
  return (
    <ReviewTree
      step={<ReviewWorkLine environmentId={environmentId} threadId={threadId} live />}
      agents={agents}
    />
  );
});

/**
 * The reviewer's current step; reads only that thread's activities. `live` draws it the way the
 * pull request card draws work in flight: the moving shine over the words.
 */
export const ReviewWorkLine = memo(function ReviewWorkLine({
  environmentId,
  threadId,
  live = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  live?: boolean;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const projection = Option.getOrNull(useEnvironmentThread(environmentId, threadId).data);
  const entries =
    projection === null
      ? []
      : deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: projection.visibleTurnItems,
          optimisticMessages: [],
          attempts: projection.attempts,
          nodes: projection.nodes,
          plans: projection.plans,
        }).flatMap((row) => (row.kind === "work" ? [row.entry] : []));
  const line = reviewWorkLine(activities ?? [], undefined, entries);
  if (live) {
    const text = line ?? "Reading the change";
    return (
      <ShimmerLabel live text={text}>
        <BlurSwap swapKey={text} render={<span className="block truncate text-muted-foreground" />}>
          {text}
        </BlurSwap>
      </ShimmerLabel>
    );
  }
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
  const agents = useReviewAgents(environmentId, threadId);
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
