import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type ChildAgentEntry,
  type ChildAgentStatus,
  collectChildAgents,
  countRunningChildAgents,
  resolveChildAgentStatus,
} from "./childAgents.logic";

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

/**
 * "Active agents" strip above the composer: the thread's child agents
 * (threads whose parentThreadId chain leads here), how many are running, a
 * disclosure listing them, and Stop all. Renders nothing without children.
 */
export const ActiveAgentsBar = memo(function ActiveAgentsBar(props: {
  threadRef: ScopedThreadRef;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const { threadRef, providers } = props;
  const threads = useThreadShells();
  const agents = useMemo(() => collectChildAgents(threads, threadRef), [threadRef, threads]);
  const runningCount = countRunningChildAgents(agents);
  const [expanded, setExpanded] = useState(false);
  // "Stopping…" holds while exactly the agents we asked to stop are still
  // running: the interrupt returning only means the request was accepted,
  // and any change in the running set re-arms Stop all.
  const runningKey = agents
    .filter((agent) => agent.running)
    .map((agent) => agent.thread.id)
    .join(",");
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const stopping = stoppingKey !== null && stoppingKey === runningKey;
  const navigate = useNavigate();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });

  const stopAll = useCallback(async () => {
    const running = agents.filter((agent) => agent.running);
    if (running.length === 0) return;
    setStoppingKey(running.map((agent) => agent.thread.id).join(","));
    const results = await Promise.all(
      running.map((agent) =>
        interruptThreadTurn({
          environmentId: agent.thread.environmentId,
          input: buildThreadTurnInterruptInput(agent.thread),
        }),
      ),
    );
    const failure = results.find(
      (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    );
    if (results.some((result) => result._tag === "Failure")) setStoppingKey(null);
    if (failure && failure._tag === "Failure") {
      const error = squashAtomCommandFailure(failure);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop every agent",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [agents, interruptThreadTurn]);

  const openAgent = useCallback(
    (thread: EnvironmentThreadShell) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.id },
      });
    },
    [navigate],
  );

  if (agents.length === 0) return null;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-active-agents-bar="true">
        <ComposerBanner.Row layout="wrap-actions-narrow">
          <ComposerBanner.Icon>
            <ComposerBanner.Dot
              className={runningCount > 0 ? "bg-success" : "bg-muted-foreground/50"}
            />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="whitespace-nowrap">
            <span className="font-medium">Active agents</span>
            <ComposerBanner.Separator />
            <span className="truncate text-muted-foreground tabular-nums">
              {runningCount > 0 ? `${runningCount} running` : `${agents.length} idle`}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {runningCount > 0 ? (
              <Button size="xs" variant="ghost" disabled={stopping} onClick={() => void stopAll()}>
                {stopping ? "Stopping…" : "Stop all"}
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
                  providers={providers}
                  onOpen={openAgent}
                />
              ))}
            </ComposerBanner.Children>
          </ComposerBanner.Scroll>
        ) : null}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});

function ActiveAgentRow(props: {
  agent: ChildAgentEntry<EnvironmentThreadShell>;
  providers: ReadonlyArray<ServerProvider>;
  onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread, depth } = props.agent;
  const status = resolveChildAgentStatus(thread);
  const provider = props.providers.find(
    (candidate) => candidate.instanceId === thread.modelSelection.instanceId,
  );
  return (
    <ComposerBanner.Row
      render={<button type="button" />}
      onClick={() => props.onOpen(thread)}
      className="hover:bg-accent/40"
    >
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
        <span className="min-w-0 truncate text-foreground">{thread.title}</span>
        <span className="hidden shrink truncate text-muted-foreground sm:inline">
          {thread.modelSelection.model}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <span className={cn("pe-2 text-2xs", STATUS_CLASS[status])}>{STATUS_LABEL[status]}</span>
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}
