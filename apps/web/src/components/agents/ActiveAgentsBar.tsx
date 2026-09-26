import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AgentControlState, ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useAgentControl } from "../../state/agentControl";
import { useThreadShells } from "../../state/entities";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  type ChildAgentEntry,
  type ChildAgentStatus,
  collectChildAgents,
  countRunningChildAgents,
  resolveChildAgentStatus,
} from "./childAgents.logic";
import { useAgentControlActions } from "./useAgentControlActions";

const STATUS_LABEL: Record<ChildAgentStatus, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  failed: "Failed",
  idle: "Idle",
};

const STATUS_CLASS: Record<ChildAgentStatus, string> = {
  approval: "text-warning",
  input: "text-warning",
  working: "text-success",
  failed: "text-destructive",
  idle: "text-muted-foreground",
};

function pausedLabel(state: AgentControlState): string {
  return state.queued > 0 ? `Paused · ${state.queued} queued` : "Paused";
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/**
 * "Active agents" strip above the composer: this thread's child agents
 * (threads whose parentThreadId chain leads here) in tree order, with Stop,
 * Resume and Discard per agent and for the whole tree. A stopped agent is
 * paused on the server: agent messages to it wait until it is resumed.
 * When this thread itself is paused, a "Stopped" notice with Resume sits on
 * top. Renders nothing when neither applies.
 */
export const ActiveAgentsBar = memo(function ActiveAgentsBar(props: {
  threadRef: ScopedThreadRef;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const { threadRef, providers } = props;
  const threads = useThreadShells();
  const control = useAgentControl(threadRef.environmentId);
  const agents = useMemo(() => collectChildAgents(threads, threadRef), [threadRef, threads]);
  const runningCount = countRunningChildAgents(agents);
  let pausedCount = 0;
  let queuedCount = 0;
  for (const agent of agents) {
    const state = control.get(agent.thread.id);
    if (state?.paused) pausedCount += 1;
    queuedCount += state?.queued ?? 0;
  }
  const selfState = control.get(threadRef.threadId);
  const [expanded, setExpanded] = useState(false);
  // "Stopping…" holds while exactly the agents we asked to stop are still
  // running: the request returning only means the server accepted it, and
  // any change in the running set re-arms Stop all.
  const runningKey = agents
    .filter((agent) => agent.running)
    .map((agent) => agent.thread.id)
    .join(",");
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const stopping = stoppingKey !== null && stoppingKey === runningKey;
  const navigate = useNavigate();
  const actions = useAgentControlActions();

  const stopAll = useCallback(async () => {
    if (runningKey === "") return;
    setStoppingKey(runningKey);
    if (!(await actions.stop(threadRef, "tree"))) setStoppingKey(null);
  }, [actions, runningKey, threadRef]);

  const openAgent = useCallback(
    (thread: EnvironmentThreadShell) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.id },
      });
    },
    [navigate],
  );

  const plural = agents.length > 1;
  const summary = [
    runningCount > 0 ? `${runningCount} running` : null,
    pausedCount > 0 ? `${pausedCount} paused` : null,
    queuedCount > 0 ? `${queuedCount} queued` : null,
  ].filter((part): part is string => part !== null);

  return (
    <>
      {selfState?.paused ? (
        <ComposerBanner.Attachment>
          <ComposerBanner.Root density="comfortable" data-agent-paused-notice="true">
            <ComposerBanner.Row layout="wrap-actions-narrow">
              <ComposerBanner.Icon>
                <ComposerBanner.Dot className="bg-warning" />
              </ComposerBanner.Icon>
              <ComposerBanner.Content className="whitespace-nowrap">
                <span className="font-medium">Stopped</span>
                <ComposerBanner.Separator />
                <span className="truncate text-muted-foreground">
                  {selfState.queued > 0
                    ? `${selfState.queued} agent message${selfState.queued === 1 ? "" : "s"} waiting`
                    : "Agent messages wait until you resume"}
                </span>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                {selfState.queued > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void actions.discard(threadRef, "thread")}
                  >
                    Discard
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void actions.resume(threadRef, agents.length > 0 ? "tree" : "thread")
                  }
                >
                  Resume
                </Button>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      ) : null}
      {agents.length > 0 ? (
        <ComposerBanner.Attachment>
          <ComposerBanner.Root density="comfortable" data-active-agents-bar="true">
            <ComposerBanner.Row layout="wrap-actions-narrow">
              <ComposerBanner.Icon>
                <ComposerBanner.Dot
                  className={
                    runningCount > 0
                      ? "bg-success"
                      : pausedCount > 0
                        ? "bg-warning"
                        : "bg-muted-foreground/50"
                  }
                />
              </ComposerBanner.Icon>
              <ComposerBanner.Content className="whitespace-nowrap">
                <span className="font-medium">Active agents</span>
                <ComposerBanner.Separator />
                <span className="truncate text-muted-foreground tabular-nums">
                  {summary.length > 0 ? summary.join(" · ") : `${agents.length} idle`}
                </span>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                {pausedCount > 0 || queuedCount > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void actions.discard(threadRef, "tree")}
                  >
                    Discard
                  </Button>
                ) : null}
                {pausedCount > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void actions.resume(threadRef, "tree")}
                  >
                    {plural ? "Resume all" : "Resume"}
                  </Button>
                ) : null}
                {runningCount > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={stopping}
                    onClick={() => void stopAll()}
                  >
                    {stopping ? "Stopping…" : plural ? "Stop all" : "Stop"}
                  </Button>
                ) : null}
                <ComposerBanner.Dismiss
                  aria-expanded={expanded}
                  aria-label={expanded ? "Hide agents" : "Show agents"}
                  onClick={() => setExpanded((value) => !value)}
                >
                  <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
                </ComposerBanner.Dismiss>
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
            {expanded ? (
              <ComposerBanner.Scroll className="max-h-[min(16rem,35dvh)]">
                <ComposerBanner.Children>
                  {agents.map((agent) => (
                    <ActiveAgentRow
                      key={agent.thread.id}
                      agent={agent}
                      control={control.get(agent.thread.id)}
                      providers={providers}
                      onOpen={openAgent}
                    />
                  ))}
                </ComposerBanner.Children>
              </ComposerBanner.Scroll>
            ) : null}
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      ) : null}
    </>
  );
});

function ActiveAgentRow(props: {
  agent: ChildAgentEntry<EnvironmentThreadShell>;
  control: AgentControlState | undefined;
  providers: ReadonlyArray<ServerProvider>;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread, depth, running } = props.agent;
  const status = resolveChildAgentStatus(thread);
  const paused = props.control?.paused === true;
  const actions = useAgentControlActions();
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const provider = props.providers.find(
    (candidate) => candidate.instanceId === thread.modelSelection.instanceId,
  );
  const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
  const modelLabel = model?.shortName ?? model?.name ?? thread.modelSelection.model;
  const providerLabel = provider?.displayName ?? provider?.instanceId;
  return (
    <ComposerBanner.Row className="hover:bg-accent/40">
      <ComposerBanner.Icon>
        {provider ? (
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={provider.displayName ?? provider.instanceId}
            iconClassName="size-3.5"
          />
        ) : null}
      </ComposerBanner.Icon>
      <ComposerBanner.Content style={{ paddingInlineStart: `${(depth - 1) * 12}px` }}>
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-start focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => props.onOpen(thread)}
        >
          {/* Static activity dots: no animation while agents run for minutes. */}
          {running ? (
            <span aria-hidden className="flex flex-none gap-0.5 text-success">
              <ComposerBanner.Dot className="size-1" />
              <ComposerBanner.Dot className="size-1" />
              <ComposerBanner.Dot className="size-1" />
            </span>
          ) : null}
          <span className="min-w-0 truncate text-foreground">{thread.title}</span>
          <Badge variant="secondary" size="sm" className="hidden min-w-0 shrink sm:inline-flex">
            <span className="truncate">
              {providerLabel ? `${providerLabel} · ${modelLabel}` : modelLabel}
            </span>
          </Badge>
        </button>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <span className={cn("pe-1 text-2xs", paused ? "text-warning" : STATUS_CLASS[status])}>
          {paused && props.control ? pausedLabel(props.control) : STATUS_LABEL[status]}
        </span>
        {paused ? (
          <Button size="xs" variant="ghost" onClick={() => void actions.resume(ref, "thread")}>
            Resume
          </Button>
        ) : running ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Stop ${thread.title}`}
            onClick={() => void actions.stop(ref, "thread")}
          >
            <StopIcon />
          </Button>
        ) : null}
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
