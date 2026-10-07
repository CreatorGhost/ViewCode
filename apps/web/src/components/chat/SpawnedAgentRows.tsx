import { useEffect, useMemo, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
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
import { useServerConfigs, useThreadShell, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import type { AgentMessageRenderContext } from "./AgentMessageCard";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

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
export const spawnedAgentDetailsKey = (messageId: string) => `agent-spawn:${messageId}`;
export const spawnedAgentsCollapsedKey = (rowId: string) => `agent-spawns-collapsed:${rowId}`;

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
  const collapsedKey = spawnedAgentsCollapsedKey(rowId);
  const collapsed = expandedKeys.has(collapsedKey);
  return (
    <div className="mx-auto w-full max-w-chat">
      <SpawnedAgentsGroupHeader
        spawns={spawns}
        context={context}
        collapsed={collapsed}
        onToggle={() => onToggle(collapsedKey, !collapsed)}
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
  const ref = useMemo(
    () => scopeThreadRef(context.environmentId, ThreadId.make(sent.toThreadId)),
    [context.environmentId, sent.toThreadId],
  );
  const shell = useThreadShell(ref);
  const providers = useServerConfigs().get(context.environmentId)?.providers;
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
  const text = useMemo(() => {
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
  }, [context.environmentId, spawns, threads]);
  return text ? <span className="text-muted-foreground"> · {text}</span> : null;
}

/**
 * Elapsed time for one agent. While it runs the text updates in place once a
 * second without re-rendering React; a finished turn shows a fixed duration.
 */
function AgentElapsed(props: { startMs: number; endMs: number | null; live: boolean }) {
  const { startMs, endMs, live } = props;
  const textRef = useRef<HTMLSpanElement>(null);
  const text = formatAgentElapsed((endMs ?? Date.now()) - startMs);
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
