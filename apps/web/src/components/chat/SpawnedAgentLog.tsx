import { resolveAgentControlAvailability } from "@t3tools/client-runtime/state/child-agents";
import {
  formatSubagentDisplayTitle,
  spawnedAgentsHeading,
  spawnedAgentsMarker,
  subagentDetailPreview,
  subagentRowIsActive,
  subagentRowState,
  subagentRowStateLabel,
  summarizeSubagentRowStates,
  visibleAgentRows,
  type SubagentRowState,
} from "@t3tools/client-runtime/state/subagent-display";
import type { WorkLogMarkerKind } from "@t3tools/client-runtime/work-log/thinking-log";
import type {
  AgentControlState,
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { ActivityShimmerOverlay } from "./ActivityShimmerOverlay";
import { SubagentElapsed, SubagentHoverDetails, SubagentProviderGlyph } from "./V2LifecycleRow";
import { WorkLogMarker, WorkLogRail, WorkLogRow, useWorkLogRailEnds } from "./WorkLog";

export type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

/** One spawned agent: its turn item, its lead's live record and its agent-control state. */
export interface SpawnedAgent {
  readonly item: SubagentItem;
  readonly live: OrchestrationV2Subagent | null;
  readonly control: AgentControlState | undefined;
}

export interface SpawnedAgentActions {
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStop: (threadId: ThreadId) => void;
  readonly onResume: (threadId: ThreadId) => void;
}

const SHIMMER_BAND = "text-muted-foreground";

function agentState(agent: SpawnedAgent): SubagentRowState {
  return subagentRowState(agent.live?.status ?? agent.item.status, agent.control);
}

function markerFor(state: SubagentRowState): WorkLogMarkerKind {
  switch (state) {
    case "working":
      return "live";
    case "done":
      return "finish";
    case "failed":
      return "dead-end";
    default:
      return "dot";
  }
}

/**
 * Agents a turn spawned, live on the rail: one row each with its provider, title, what it is
 * doing now and how long it has run. More than one gets a header that summarises them and
 * expands to their full cards.
 */
export function SpawnedAgentLog(props: {
  readonly environmentId: EnvironmentId;
  readonly parentRef: ScopedThreadRef;
  readonly agents: ReadonlyArray<SpawnedAgent>;
  readonly elapsed: ReactNode;
  readonly expanded: boolean;
  readonly onToggleExpanded: (open: boolean) => void;
  readonly cards: ReactNode;
  readonly actions: SpawnedAgentActions;
}) {
  const { agents, expanded, onToggleExpanded } = props;
  const ends = useWorkLogRailEnds();
  if (agents.length === 1) {
    return <SpawnedAgentRow {...props} agent={agents[0]!} lane="main" />;
  }
  const states = agents.map(agentState);
  const working = states.some((state) => state === "working");
  const heading = spawnedAgentsHeading(agents.length);
  const { visible, hidden } = visibleAgentRows(agents);
  const toggle = () => onToggleExpanded(!expanded);
  return (
    <>
      <WorkLogRail ends={{ above: ends.above, below: true }}>
        <div ref={working ? observeVisibleAnimation : undefined}>
          <WorkLogRow
            role="button"
            tabIndex={0}
            aria-label={`${heading}: ${summarizeSubagentRowStates(states)}`}
            aria-expanded={expanded}
            onClick={toggle}
            onKeyDown={(event) => activateOnKey(event, toggle)}
            marker={spawnedAgentsMarker(states)}
            tone={states.some(subagentRowIsActive) ? "active" : "done"}
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="relative shrink-0 overflow-hidden whitespace-nowrap">
                  {heading}
                  {working ? (
                    <ActivityShimmerOverlay className={SHIMMER_BAND}>
                      {heading}
                    </ActivityShimmerOverlay>
                  ) : null}
                </span>
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  {summarizeSubagentRowStates(states)}
                </span>
              </span>
            }
            trailing={
              <>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {props.elapsed}
                </span>
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    expanded && "rotate-180",
                  )}
                />
              </>
            }
          />
        </div>
      </WorkLogRail>
      {expanded ? (
        props.cards
      ) : (
        <>
          {visible.map((agent, index) => (
            <WorkLogRail
              key={agent.item.id}
              ends={{ above: true, below: index < visible.length - 1 || hidden > 0 || ends.below }}
            >
              <SpawnedAgentRow
                {...props}
                agent={agent}
                lane={index === 0 ? "branch-start" : "branch"}
              />
            </WorkLogRail>
          ))}
          {hidden > 0 ? (
            <WorkLogRail ends={{ above: true, below: ends.below }}>
              <WorkLogRow
                role="button"
                tabIndex={0}
                onClick={() => onToggleExpanded(true)}
                onKeyDown={(event) => activateOnKey(event, () => onToggleExpanded(true))}
                marker="dot"
                lane="branch"
                label={<span className="truncate">+{hidden} more</span>}
              />
            </WorkLogRail>
          ) : null}
        </>
      )}
    </>
  );
}

function activateOnKey(event: KeyboardEvent<HTMLDivElement>, run: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    run();
  }
}

/**
 * One agent on the rail. While it works: a spinner, its title shimmering in the live colour and
 * its current step. Done draws a check, a failure ends on ×, paused and queued say so. Clicking
 * opens its thread; Stop and Resume show on hover for agents ViewCode runs.
 */
function SpawnedAgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly parentRef: ScopedThreadRef;
  readonly agent: SpawnedAgent;
  readonly lane: "main" | "branch" | "branch-start";
  readonly actions: SpawnedAgentActions;
}) {
  const { agent, actions } = props;
  const { item, live, control } = agent;
  const state = agentState(agent);
  const status = live?.status ?? item.status;
  // The check draws only when this agent finishes while its row is on screen.
  const [seenState, setSeenState] = useState(state);
  const [finishedHere, setFinishedHere] = useState(false);
  if (seenState !== state) {
    setSeenState(state);
    if (state === "done") setFinishedHere(true);
  }
  const working = state === "working";
  const title = formatSubagentDisplayTitle(item.title ?? "Subagent");
  const detail = subagentDetailPreview({
    status,
    result: live?.result ?? item.result,
    progress: live?.progress ?? item.progress,
  });
  const threadId = item.childThreadId;
  const controllable = item.origin === "app_owned" && threadId !== null;
  const availability = resolveAgentControlAvailability({ running: working, control });
  const marker = markerFor(state);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const row = (
    <WorkLogRow
      {...(threadId === null
        ? {}
        : {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": `Open ${title}`,
            onClick: () => actions.onOpenThread(threadId),
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) =>
              activateOnKey(event, () => actions.onOpenThread(threadId)),
          })}
      aria-description={subagentRowStateLabel(state, control)}
      marker={marker}
      icon={
        marker === "finish" ? (
          <WorkLogMarker kind="finish" accent={false} fresh={finishedHere} />
        ) : undefined
      }
      tone={subagentRowIsActive(state) ? "active" : "done"}
      lane={props.lane}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center">
            <SubagentProviderGlyph
              environmentId={props.environmentId}
              providerInstanceId={item.providerInstanceId}
              driver={item.driver}
            />
          </span>
          <span className="relative min-w-0 shrink-0 overflow-hidden truncate">
            {title}
            {working ? (
              <ActivityShimmerOverlay className={SHIMMER_BAND}>{title}</ActivityShimmerOverlay>
            ) : null}
          </span>
          {detail ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{detail}</span>
          ) : null}
        </span>
      }
      trailing={
        <>
          {working ? null : (
            <span
              className={cn(
                "shrink-0 text-xs",
                state === "failed"
                  ? "text-destructive"
                  : state === "paused" || state === "queued" || state === "waiting"
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {subagentRowStateLabel(state, control)}
            </span>
          )}
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            <SubagentElapsed
              agent={{
                status,
                startedAt: isoOrNull(live?.startedAt ?? item.startedAt),
                completedAt: isoOrNull(live?.completedAt ?? item.completedAt),
              }}
            />
          </span>
          {controllable && (availability.stop || availability.resume) ? (
            <span className="hidden shrink-0 group-hover/timeline-row:inline-flex group-focus-within/timeline-row:inline-flex">
              <Button
                size="xs"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation();
                  if (availability.resume) actions.onResume(threadId);
                  else actions.onStop(threadId);
                }}
                onKeyDown={stop}
              >
                {availability.resume ? "Resume" : "Stop"}
              </Button>
            </span>
          ) : null}
          {threadId !== null ? (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
          ) : null}
        </>
      }
    />
  );
  return (
    <div ref={working ? observeVisibleAnimation : undefined}>
      <Tooltip>
        <TooltipTrigger delay={300} render={row} />
        <ThreadHoverCardPopup>
          <SubagentHoverDetails
            parentRef={props.parentRef}
            item={item}
            agent={live}
            onOpenThread={actions.onOpenThread}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </div>
  );
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}
