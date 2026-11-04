import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon, ListChecksIcon } from "lucide-react";
import { AGENT_REVIEW_MODES, ThreadId } from "@t3tools/contracts";
import {
  latestReviewFindingsSource,
  reviewProgress,
  reviewRunState,
} from "@t3tools/client-runtime/review-findings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectChildAgents,
  SPAWNED_AGENT_STATUS_LABEL,
  type SpawnedAgentRowStatus,
  formatAgentElapsed,
  resolveSpawnedAgentRowStatus,
  spawnedAgentElapsedRange,
  spawnedAgentTaskTitle,
} from "@t3tools/client-runtime/state/child-agents";
import type { AgentMessageSentPayload } from "@t3tools/shared/agentMessages";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  useViewCodeThreadShell as useThreadShell,
  useViewCodeThreadShells as useThreadShells,
} from "../../state/viewcodeThreadShells";
import { useEnvironmentProviders } from "../../state/environments";
import { useRightPanelStore } from "../../rightPanelStore";
import { useAgentControl } from "../../state/agentControl";
import { environmentThreadDetails } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import type { AgentMessageRenderContext } from "./AgentMessageCard";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { spawnedAgentsOpenKey } from "./SpawnedAgentRows.logic";
import { ReviewAgentList, ReviewElapsed, ReviewWorkLine } from "./ReviewProgress";

const STATUS_DOT_CLASS: Record<SpawnedAgentRowStatus, string> = {
  running: "bg-success",
  approval: "bg-warning",
  input: "bg-warning",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground",
  done: "bg-muted-foreground/50",
  queued: "bg-warning",
  idle: "bg-muted-foreground/50",
};

const STATUS_TEXT_CLASS: Partial<Record<SpawnedAgentRowStatus, string>> = {
  approval: "text-warning",
  input: "text-warning",
  failed: "text-destructive",
};

/** Disclosure keys, kept in the timeline's spawn-row state so they survive virtualization. */
const spawnedAgentDetailsKey = (messageId: string) => `agent-spawn:${messageId}`;

/**
 * Child agents this thread started, one line each: provider icon with a
 * status dot, "name: task · status", elapsed time and a chevron that shows
 * the full prompt. Back-to-back spawns share one row that summarises them.
 */
export function SpawnedAgentRows(props: {
  rowId: string;
  spawns: ReadonlyArray<AgentMessageSentPayload>;
  context: AgentMessageRenderContext;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  const { rowId, spawns, context, expandedKeys, onToggle } = props;
  if (spawns.length === 1) {
    const [sent] = spawns;
    return sent ? (
      <div className="mx-auto w-full max-w-chat">
        <SpawnedAgentRow
          sent={sent}
          context={context}
          expanded={expandedKeys.has(spawnedAgentDetailsKey(sent.messageId))}
          onToggle={onToggle}
        />
      </div>
    ) : null;
  }
  const openKey = spawnedAgentsOpenKey(rowId);
  const collapsed = !expandedKeys.has(openKey);
  return (
    <div className="mx-auto w-full max-w-chat">
      <SpawnedAgentsGroupHeader
        spawns={spawns}
        context={context}
        collapsed={collapsed}
        onToggle={() => onToggle(openKey, collapsed)}
      />
      {collapsed ? null : (
        <div className="ms-3 border-border/60 border-s ps-1">
          {spawns.map((sent) => (
            <SpawnedAgentRow
              key={sent.messageId}
              sent={sent}
              context={context}
              expanded={expandedKeys.has(spawnedAgentDetailsKey(sent.messageId))}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function useSpawnedAgent(sent: AgentMessageSentPayload, context: AgentMessageRenderContext) {
  const ref = scopeThreadRef(context.environmentId, ThreadId.make(sent.toThreadId));
  const shell = useThreadShell(ref);
  const providers = useEnvironmentProviders().get(context.environmentId);
  const instanceId = shell?.session?.providerInstanceId ?? shell?.modelSelection.instanceId;
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === shell?.modelSelection.model);
  return {
    ref,
    shell,
    provider,
    modelLabel: shell ? (model?.shortName ?? model?.name ?? shell.modelSelection.model) : null,
    status: resolveSpawnedAgentRowStatus(shell, sent.delivery),
  };
}

function SpawnedAgentRow(props: {
  sent: AgentMessageSentPayload;
  context: AgentMessageRenderContext;
  expanded: boolean;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  if (props.sent.review !== undefined) return <ReviewAgentRow {...props} />;
  return <PlainSpawnedAgentRow {...props} />;
}

function PlainSpawnedAgentRow(props: {
  sent: AgentMessageSentPayload;
  context: AgentMessageRenderContext;
  expanded: boolean;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  const { sent, context, expanded, onToggle } = props;
  const { ref, shell, provider, modelLabel, status } = useSpawnedAgent(sent, context);
  const name = shell?.title.trim() || sent.toName.trim() || "Agent";
  const task = spawnedAgentTaskTitle(sent);
  const range = spawnedAgentElapsedRange(shell);
  const title = (
    <>
      <span className="font-medium text-foreground">{task ? `${name}:` : name}</span>
      {task ? <span className="text-foreground"> {task}</span> : null}
      {status ? (
        <span className={cn("text-muted-foreground", STATUS_TEXT_CLASS[status])}>
          {" "}
          · {SPAWNED_AGENT_STATUS_LABEL[status]}
        </span>
      ) : null}
    </>
  );
  return (
    <div data-agent-message-id={sent.messageId}>
      <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/40">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={provider.displayName ?? provider.instanceId}
              iconClassName="size-3.5"
              {...(status ? { statusDotClassName: STATUS_DOT_CLASS[status] } : {})}
              indicatorBackground="var(--background)"
            />
          ) : (
            <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
        </span>
        {shell ? (
          <Link
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(ref)}
            className="min-w-0 flex-1 truncate text-sm no-underline focus-visible:outline-2 focus-visible:outline-ring"
            title={`Open ${name}`}
          >
            {title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        )}
        {range ? (
          <AgentElapsed
            startMs={range.startMs}
            endMs={range.endMs}
            live={status === "running" && range.endMs === null}
          />
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${name}'s instructions` : `Show ${name}'s instructions`}
          onClick={() => onToggle(spawnedAgentDetailsKey(sent.messageId), !expanded)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      </div>
      {expanded ? (
        <div className="ms-10 me-2 mb-2 flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground text-xs">
            {[
              provider?.displayName ?? null,
              modelLabel,
              sent.delivery === "queued" ? "queued" : null,
              sent.replyExpected ? "replies to this chat" : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </span>
          <ChatMarkdown
            className="text-foreground"
            text={sent.body}
            cwd={context.markdownCwd}
            threadRef={context.threadRef ?? undefined}
            lineBreaks
            skills={context.skills}
            headingLevelOffset={3}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A review started from this chat, as one compact block: "Deep review · GPT-6.1 · Running" with
 * its time, and while it works its current step and the agents it started. Its findings are in
 * the Review panel, which "Show findings" opens beside the chat; the reviewer's own chat opens
 * only from the details.
 */
function ReviewAgentRow(props: {
  sent: AgentMessageSentPayload;
  context: AgentMessageRenderContext;
  expanded: boolean;
  onToggle: (key: string, expanded: boolean) => void;
}) {
  const { sent, context, expanded, onToggle } = props;
  const { ref, shell, provider, modelLabel, status: rowStatus } = useSpawnedAgent(sent, context);
  const threads = useThreadShells();
  const control = useAgentControl(context.environmentId);
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  const progress = (() => {
    if (shell === null) return null;
    const agents = collectChildAgents(threads, {
      environmentId: context.environmentId,
      threadId: shell.id,
    }).map((agent) => agent.thread);
    const queued = (threadId: string) => control.get(threadId)?.queued ?? 0;
    const findings =
      latestReviewFindingsSource({ id: shell.id, title: shell.title, activities: activities ?? [] })
        ?.findings ?? null;
    return reviewProgress({ run: reviewRunState(shell, agents, queued), findings });
  })();
  const running = progress?.kind === "running";
  // The reviewer waits between turns for its agents' answers; it is still reviewing then. One that
  // sent its final findings is done, as its panel says, even if its session errored afterwards.
  const status: SpawnedAgentRowStatus | null = running
    ? "running"
    : progress?.kind === "done"
      ? "done"
      : rowStatus;
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === sent.review)?.label ?? "Review";
  // The whole review, from its start to its reviewer's last turn, in the panel's words.
  const lastTurn = spawnedAgentElapsedRange(shell);
  const threadRef = context.threadRef;
  return (
    <div data-agent-message-id={sent.messageId}>
      <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/40">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={provider.displayName ?? provider.instanceId}
              iconClassName="size-3.5"
              {...(status
                ? {
                    statusDotClassName: cn(
                      STATUS_DOT_CLASS[status],
                      status === "running" && "motion-safe:animate-status-pulse",
                    ),
                  }
                : {})}
              indicatorBackground="var(--background)"
            />
          ) : (
            <ListChecksIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium text-foreground">{mode}</span>
          {modelLabel ? <span className="text-foreground"> · {modelLabel}</span> : null}
          {status ? (
            <span className={cn("text-muted-foreground", STATUS_TEXT_CLASS[status])}>
              {" "}
              · {running ? "Reviewing" : SPAWNED_AGENT_STATUS_LABEL[status]}
            </span>
          ) : null}
        </span>
        {shell && lastTurn ? (
          <ReviewElapsed startedAt={shell.createdAt} endMs={running ? null : lastTurn.endMs} />
        ) : null}
        {threadRef ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => useRightPanelStore.getState().open(threadRef, "review")}
          >
            Show findings
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide the review's details" : "Show the review's details"}
          onClick={() => onToggle(spawnedAgentDetailsKey(sent.messageId), !expanded)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      </div>
      {running && shell ? (
        <div className="ms-8 mb-1 flex flex-col gap-0.5 text-muted-foreground text-xs">
          <ReviewWorkLine environmentId={context.environmentId} threadId={shell.id} />
          <ReviewAgentList environmentId={context.environmentId} threadId={shell.id} />
        </div>
      ) : null}
      {expanded ? (
        <div className="ms-10 me-2 mb-2 flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            {[provider?.displayName ?? null, shell?.title ?? sent.toName]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
            {shell ? (
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(ref)}
                className="text-foreground hover:underline"
              >
                View agent
              </Link>
            ) : null}
          </span>
          <ChatMarkdown
            className="text-foreground"
            text={sent.body}
            cwd={context.markdownCwd}
            threadRef={context.threadRef ?? undefined}
            lineBreaks
            skills={context.skills}
            headingLevelOffset={3}
          />
        </div>
      ) : null}
    </div>
  );
}

function SpawnedAgentsGroupHeader(props: {
  spawns: ReadonlyArray<AgentMessageSentPayload>;
  context: AgentMessageRenderContext;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { spawns, context, collapsed, onToggle } = props;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-start text-sm hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span className="flex shrink-0 -space-x-2">
        {spawns.slice(0, 3).map((sent) => (
          <GroupAvatar key={sent.messageId} sent={sent} context={context} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{spawns.length} agents</span>
        <GroupSummary spawns={spawns} context={context} />
      </span>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !collapsed && "rotate-180",
        )}
      />
    </button>
  );
}

function GroupAvatar(props: { sent: AgentMessageSentPayload; context: AgentMessageRenderContext }) {
  const { provider } = useSpawnedAgent(props.sent, props.context);
  return (
    <span className="flex size-6 items-center justify-center rounded-full bg-muted ring-2 ring-background">
      {provider ? (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={provider.displayName ?? provider.instanceId}
          iconClassName="size-3.5"
        />
      ) : (
        <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

const SUMMARY_ORDER: ReadonlyArray<SpawnedAgentRowStatus> = [
  "approval",
  "input",
  "running",
  "queued",
  "failed",
  "stopped",
  "done",
  "idle",
];

/** " · 2 running, 1 done": how many of the group's agents are in each state. */
function GroupSummary(props: {
  spawns: ReadonlyArray<AgentMessageSentPayload>;
  context: AgentMessageRenderContext;
}) {
  const { spawns, context } = props;
  const threads = useThreadShells();
  const text = (() => {
    const wanted = new Map(spawns.map((sent) => [sent.toThreadId, sent.delivery] as const));
    const counts = new Map<SpawnedAgentRowStatus, number>();
    for (const thread of threads) {
      if (thread.environmentId !== context.environmentId) continue;
      const delivery = wanted.get(thread.id);
      if (delivery === undefined) continue;
      const status = resolveSpawnedAgentRowStatus(thread, delivery);
      if (status) counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return SUMMARY_ORDER.flatMap((status) => {
      const count = counts.get(status);
      return count ? [`${count} ${SPAWNED_AGENT_STATUS_LABEL[status].toLowerCase()}`] : [];
    }).join(", ");
  })();
  return text ? <span className="text-muted-foreground"> · {text}</span> : null;
}

/**
 * Elapsed time for one agent. While it runs the text updates in place once a
 * second without re-rendering React; a finished turn shows a fixed duration.
 */
function AgentElapsed(props: { startMs: number; endMs: number | null; live: boolean }) {
  const { startMs, endMs, live } = props;
  const textRef = useRef<HTMLSpanElement>(null);
  const text = endMs === null ? "" : formatAgentElapsed(endMs - startMs);
  useEffect(() => {
    if (!live) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatAgentElapsed(Date.now() - startMs);
    };
    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, startMs]);
  if (!live && endMs === null) return null;
  return (
    <span ref={textRef} className="shrink-0 text-muted-foreground text-xs tabular-nums">
      {text}
    </span>
  );
}
