import { useAtomValue } from "@effect/atom-react";
import {
  collectChildAgents,
  resolveAgentControlAvailability,
  summarizeAgentTreeControl,
} from "@t3tools/client-runtime/state/child-agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AgentControlState, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useAgentControlByThreadKey } from "../../state/agentControl";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  type HomeAgentStatus,
  resolveHomeAgentModelLabel,
  resolveHomeAgentStatus,
} from "../home/homeFolderList";
import { pausedAgentLabel } from "./agentMenus";
import { useAgentControlActions } from "./useAgentControlActions";

const STATUS_DOT_CLASS = {
  "needs-you": "bg-adaptive-amber-700-400",
  working: "bg-adaptive-sky-600-400",
  paused: "bg-adaptive-amber-700-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
  idle: "bg-adaptive-emerald-600-400",
} as const satisfies Record<HomeAgentStatus, string>;

const STATUS_LABEL = {
  "needs-you": "Needs you",
  working: "Working",
  paused: "Paused",
  failed: "Failed",
  stopped: "Idle",
  idle: "Idle",
} as const satisfies Record<HomeAgentStatus, string>;

function StripButton(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      hitSlop={6}
      className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70 disabled:opacity-50"
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-xs font-t3-bold",
          props.tone === "danger" ? "text-adaptive-rose-600-400" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * The thread screen's "Active agents" strip above the composer, like the
 * desktop bar: this thread's child agents with status and model, Stop /
 * Resume per agent, and Stop all / Resume / Discard for the tree. When this
 * thread itself was stopped (paused), a "Stopped" row with Resume sits on
 * top, so a stop is never a one-way door. Renders nothing outside agent trees.
 */
export const ActiveAgentsStrip = memo(function ActiveAgentsStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { environmentId, threadId } = props;
  const threads = useThreadShells();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const agents = useMemo(
    () => collectChildAgents(threads, { environmentId, threadId }),
    [environmentId, threadId, threads],
  );
  const inTree = agents.length > 0 || props.parentThreadId !== null;
  const controlEnvironmentIds = useMemo(
    () => (inTree ? [environmentId] : []),
    [environmentId, inTree],
  );
  const control = useAgentControlByThreadKey(controlEnvironmentIds);
  const actions = useAgentControlActions();
  // Opens while agents run so their progress shows without a tap; a manual
  // toggle sticks for the rest of the visit.
  const [manualExpanded, setExpanded] = useState<boolean | null>(null);

  const keyOf = (id: ThreadId) => `${environmentId}:${id}`;
  const summary = summarizeAgentTreeControl(
    agents.map((agent) => ({ running: agent.running, key: keyOf(agent.thread.id) })),
    control,
  );
  const expanded = manualExpanded ?? summary.running > 0;
  const selfState = control.get(keyOf(threadId));
  const self = { environmentId, id: threadId };
  if (!selfState?.paused && agents.length === 0) return null;

  const plural = agents.length > 1;
  const summaryText =
    [
      summary.running > 0 ? `${summary.running} running` : null,
      summary.paused > 0 ? `${summary.paused} paused` : null,
      summary.queued > 0 ? `${summary.queued} queued` : null,
    ]
      .filter((part) => part !== null)
      .join(" · ") || `${agents.length} idle`;

  return (
    <View className="shrink-0 px-4 pb-3">
      <View className="overflow-hidden rounded-[20px] border border-border-subtle bg-card-alt">
        {selfState?.paused ? (
          <View className="flex-row items-center gap-2 px-4 py-2.5">
            <View className="size-2 rounded-full bg-adaptive-amber-700-400" />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-t3-medium text-foreground">Stopped</Text>
              <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
                {selfState.queued > 0
                  ? `${selfState.queued} agent message${selfState.queued === 1 ? "" : "s"} waiting`
                  : "Agent messages wait until you resume"}
              </Text>
            </View>
            {selfState.queued > 0 ? (
              <StripButton
                label="Discard"
                tone="danger"
                onPress={() => actions.confirmDiscard(self, "thread")}
              />
            ) : null}
            <StripButton
              label="Resume"
              onPress={() => void actions.resume(self, agents.length > 0 ? "tree" : "thread")}
            />
          </View>
        ) : null}
        {agents.length > 0 ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Active agents, ${summaryText}`}
              accessibilityHint={`${expanded ? "Hides" : "Shows"} this thread's agents.`}
              accessibilityState={{ expanded }}
              className={cn(
                "flex-row items-center gap-2 px-4 py-2.5 active:opacity-70",
                selfState?.paused && "border-t border-border-subtle",
              )}
              onPress={() => setExpanded(!expanded)}
            >
              <View
                className={cn(
                  "size-2 rounded-full",
                  summary.running > 0
                    ? "bg-adaptive-sky-600-400"
                    : summary.paused > 0
                      ? "bg-adaptive-amber-700-400"
                      : "bg-foreground-muted",
                )}
              />
              <Text className="text-sm font-t3-medium text-foreground">Active agents</Text>
              <Text
                className="min-w-0 flex-1 text-xs tabular-nums text-foreground-tertiary"
                numberOfLines={1}
              >
                {summaryText}
              </Text>
              {summary.paused > 0 || summary.queued > 0 ? (
                <StripButton
                  label="Discard"
                  accessibilityLabel="Discard held agent messages"
                  tone="danger"
                  onPress={() => actions.confirmDiscard(self, "tree")}
                />
              ) : null}
              {summary.paused > 0 ? (
                <StripButton
                  label={plural ? "Resume all" : "Resume"}
                  onPress={() => void actions.resume(self, "tree")}
                />
              ) : null}
              {summary.running > 0 ? (
                <StripButton
                  label={plural ? "Stop all" : "Stop"}
                  accessibilityLabel={`Stop all agents (${summary.running} running)`}
                  onPress={() => void actions.stop(self, "tree")}
                />
              ) : null}
              <SymbolView
                name="chevron.right"
                size={11}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
                style={{ transform: [{ rotate: expanded ? "90deg" : "-90deg" }] }}
              />
            </Pressable>
            {expanded ? (
              <ScrollView className="max-h-56 border-t border-border-subtle" nestedScrollEnabled>
                {agents.map((agent) => (
                  <ActiveAgentRow
                    key={agent.thread.id}
                    thread={agent.thread}
                    depth={agent.depth}
                    running={agent.running}
                    control={control.get(keyOf(agent.thread.id))}
                    modelLabel={resolveHomeAgentModelLabel(serverConfigs, agent.thread)}
                    onOpen={props.onOpenThread}
                    onStop={() =>
                      void actions.stop({ environmentId, id: agent.thread.id }, "thread")
                    }
                    onResume={() =>
                      void actions.resume({ environmentId, id: agent.thread.id }, "thread")
                    }
                  />
                ))}
              </ScrollView>
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
});

function ActiveAgentRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly running: boolean;
  readonly control: AgentControlState | undefined;
  readonly modelLabel: string | null;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
  readonly onStop: () => void;
  readonly onResume: () => void;
}) {
  const { thread } = props;
  const status = resolveHomeAgentStatus(thread);
  const availability = resolveAgentControlAvailability({
    running: props.running,
    control: props.control,
  });
  const paused = props.control?.paused === true;
  const statusText = paused ? pausedAgentLabel(props.control?.queued ?? 0) : STATUS_LABEL[status];
  return (
    <View
      className="flex-row items-center gap-2 py-2 pr-3"
      style={{ paddingLeft: 16 + (props.depth - 1) * 12 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${thread.title}, ${statusText}${props.modelLabel ? `, ${props.modelLabel}` : ""}`}
        accessibilityHint="Opens the agent."
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
        onPress={() => props.onOpen(thread)}
      >
        <View
          className={cn(
            "size-2 rounded-full",
            paused ? "bg-adaptive-amber-700-400" : STATUS_DOT_CLASS[status],
          )}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {thread.title}
          </Text>
          <Text
            className={cn(
              "text-xs",
              paused ? "text-adaptive-amber-700-400" : "text-foreground-tertiary",
            )}
            numberOfLines={1}
          >
            {props.modelLabel ? `${statusText} · ${props.modelLabel}` : statusText}
          </Text>
        </View>
      </Pressable>
      {availability.resume ? (
        <StripButton
          label="Resume"
          accessibilityLabel={`Resume ${thread.title}`}
          onPress={props.onResume}
        />
      ) : availability.stop ? (
        <StripButton
          label="Stop"
          accessibilityLabel={`Stop ${thread.title}`}
          onPress={props.onStop}
        />
      ) : null}
    </View>
  );
}
