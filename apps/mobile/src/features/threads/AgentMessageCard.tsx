import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SPAWNED_AGENT_STATUS_LABEL,
  type SpawnedAgentRowStatus,
  formatAgentElapsed,
  resolveSpawnedAgentRowStatus,
  spawnedAgentElapsedRange,
  spawnedAgentTaskTitle,
} from "@t3tools/client-runtime/state/child-agents";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { AgentMessageEnvelope, AgentMessageSentPayload } from "@t3tools/shared/agentMessages";
import { useNavigation } from "@react-navigation/native";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveHomeAgentModelLabel } from "../home/homeFolderList";

// Bodies past this clamp to a few lines with a tap to expand, like web.
const LONG_BODY_CHARS = 240;

/**
 * An agent-to-agent message: "from <agent>" when another agent wrote to this
 * thread, "to <agent>" when this thread's agent wrote out. Mirrors web's
 * AgentMessageCard so a message never reads as something the user typed.
 */
function AgentMessageCardFrame(props: {
  readonly icon: "tray" | "paperplane" | "cpu";
  readonly verb: string;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly badge: ReactNode;
  readonly body: string;
  readonly iconColor: ColorValue;
  /** Formatted send time, shown at the header's end like normal messages. */
  readonly timeLabel: string;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const long = props.body.length > LONG_BODY_CHARS;
  const name = props.name.trim() || "agent";
  return (
    <View className="mb-4 rounded-lg border border-border bg-card px-3 py-2.5">
      <View className="flex-row items-center gap-1.5">
        <SymbolView name={props.icon} size={13} tintColor={props.iconColor} type="monochrome" />
        <Text className="text-xs text-foreground-muted">{props.verb}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens that agent's thread."
          className="min-w-0 shrink"
          hitSlop={6}
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: props.threadId,
            })
          }
        >
          <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
        {props.badge}
        {props.timeLabel ? (
          <Text className="ml-auto shrink-0 pl-2 text-xs text-foreground-tertiary">
            {props.timeLabel}
          </Text>
        ) : null}
      </View>
      {props.body.trim().length > 0 ? (
        <Text
          selectable
          className="mt-1.5 text-sm text-foreground"
          numberOfLines={long && !expanded ? 4 : undefined}
        >
          {props.body.trim()}
        </Text>
      ) : null}
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="-mb-2.5 min-h-10 justify-center self-stretch active:opacity-70"
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Badge(props: { readonly label: string; readonly tone?: "warning" }) {
  return (
    <View
      className={cn(
        "rounded-sm px-1.5 py-0.5",
        props.tone === "warning" ? "bg-warning" : "bg-subtle-strong",
      )}
    >
      <Text
        className={cn(
          "text-3xs font-t3-medium",
          props.tone === "warning" ? "text-warning-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

export const IncomingAgentMessageCard = memo(function IncomingAgentMessageCard(props: {
  readonly envelope: AgentMessageEnvelope;
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly timeLabel: string;
}) {
  const { envelope } = props;
  return (
    <AgentMessageCardFrame
      icon="tray"
      verb="from"
      name={envelope.fromName}
      environmentId={props.environmentId}
      threadId={envelope.fromThreadId}
      body={envelope.body}
      iconColor={props.iconColor}
      timeLabel={props.timeLabel}
      badge={
        envelope.inReplyTo ? (
          <Text className="shrink-0 text-xs text-foreground-muted">· reply</Text>
        ) : envelope.replyExpected ? (
          <Badge label="Reply expected" />
        ) : null
      }
    />
  );
});

export const OutgoingAgentMessageCard = memo(function OutgoingAgentMessageCard(props: {
  readonly sent: AgentMessageSentPayload;
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly timeLabel: string;
}) {
  const { sent } = props;
  if (sent.kind === "spawn") {
    return <SpawnedAgentRow sent={sent} environmentId={props.environmentId} />;
  }
  return (
    <AgentMessageCardFrame
      icon="paperplane"
      verb="to"
      name={sent.toName}
      environmentId={props.environmentId}
      threadId={sent.toThreadId}
      body={sent.body}
      iconColor={props.iconColor}
      timeLabel={props.timeLabel}
      badge={sent.delivery === "queued" ? <Badge label="queued" tone="warning" /> : null}
    />
  );
});

// Same colours as the agents strip's summary dot.
const STATUS_DOT_CLASS: Record<SpawnedAgentRowStatus, string> = {
  running: "bg-adaptive-sky-600-400",
  approval: "bg-adaptive-amber-700-400",
  input: "bg-adaptive-amber-700-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
  done: "bg-foreground-muted",
  queued: "bg-adaptive-amber-700-400",
  idle: "bg-foreground-muted",
};

/**
 * A child agent this thread started, on one line like web: provider icon with
 * a status dot, "name: task · status" and elapsed time. Tap opens the agent;
 * the chevron shows its instructions.
 */
function SpawnedAgentRow(props: {
  readonly sent: AgentMessageSentPayload;
  readonly environmentId: EnvironmentId;
}) {
  const { sent, environmentId } = props;
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(sent.toThreadId)),
    [environmentId, sent.toThreadId],
  );
  const shell = useThreadShell(ref);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const instanceId = shell?.session?.providerInstanceId ?? shell?.modelSelection.instanceId;
  const provider = serverConfigs
    .get(environmentId)
    ?.providers.find((candidate) => candidate.instanceId === instanceId);
  const status = resolveSpawnedAgentRowStatus(shell, sent.delivery);
  const range = spawnedAgentElapsedRange(shell);
  const live = status === "running" && range !== null && range.endMs === null;
  const nowMs = useSecondTicker(live);
  const name = shell?.title.trim() || sent.toName.trim() || "Agent";
  const task = spawnedAgentTaskTitle(sent);
  const modelLabel = shell ? resolveHomeAgentModelLabel(serverConfigs, shell) : null;
  return (
    <View className="mb-3">
      <View className="flex-row items-center gap-2.5">
        <View className="relative h-6 w-6 items-center justify-center rounded-full bg-subtle-strong">
          {provider ? (
            <ProviderIcon provider={provider.driver} size={14} />
          ) : (
            <SymbolView name="cpu" size={12} type="monochrome" />
          )}
          {status ? (
            <View
              className={cn(
                "absolute -left-0.5 -top-0.5 h-2 w-2 rounded-full",
                STATUS_DOT_CLASS[status],
              )}
            />
          ) : null}
        </View>
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens that agent's thread."
          className="min-w-0 flex-1 active:opacity-70"
          disabled={!shell}
          onPress={() =>
            navigation.navigate("Thread", { environmentId, threadId: sent.toThreadId })
          }
        >
          <Text className="text-sm text-foreground" numberOfLines={1}>
            <Text className="font-t3-medium">{task ? `${name}:` : name}</Text>
            {task ? ` ${task}` : ""}
            {status ? (
              <Text
                className={cn(
                  "text-foreground-muted",
                  status === "failed" && "text-adaptive-rose-600-400",
                )}
              >
                {` · ${SPAWNED_AGENT_STATUS_LABEL[status]}`}
              </Text>
            ) : null}
          </Text>
        </Pressable>
        {range && (range.endMs !== null || live) ? (
          <Text className="shrink-0 text-xs text-foreground-tertiary">
            {formatAgentElapsed((range.endMs ?? nowMs) - range.startMs)}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? `Hide ${name}'s instructions` : `Show ${name}'s instructions`
          }
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((value) => !value)}
          className="active:opacity-70"
        >
          <SymbolView name={expanded ? "chevron.up" : "chevron.down"} size={11} type="monochrome" />
        </Pressable>
      </View>
      {expanded ? (
        <View className="ml-8 mt-1.5 gap-1">
          {modelLabel || provider ? (
            <Text className="text-xs text-foreground-muted">
              {[provider?.displayName ?? null, modelLabel].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          <Text selectable className="text-sm text-foreground">
            {sent.body.trim()}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Now, refreshed once a second while `active`; frozen otherwise. */
function useSecondTicker(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}
