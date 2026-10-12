import { useAtomValue } from "@effect/atom-react";
import { formatReviewDuration, formatReviewElapsed } from "@t3tools/client-runtime/agent-review";
import { reviewProgress } from "@t3tools/client-runtime/review-findings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SPAWNED_AGENT_STATUS_LABEL,
  type SpawnedAgentRowStatus,
  formatAgentElapsed,
  resolveSpawnedAgentRowStatus,
  spawnedAgentElapsedRange,
  spawnedAgentTaskTitle,
} from "@t3tools/client-runtime/state/child-agents";
import { type AgentReviewMode, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import type { AgentMessageEnvelope, AgentMessageSentPayload } from "@t3tools/shared/agentMessages";
import { StackActions, useNavigation } from "@react-navigation/native";
import { memo, useMemo, useState, type ReactNode } from "react";
import * as Haptics from "expo-haptics";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveHomeAgentModelLabel } from "../home/homeFolderList";
import {
  agentReviewModeLabel,
  useMinuteClock,
  useReviewerRun,
} from "../review/agent/useAgentReviews";
import { useReviewThreadFindings } from "../review/findings/useReviewThreadFindings";
import type { AgentChatterHeaderEntry } from "./agentChatter";
import { ThreadDisclosureChevron } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

/**
 * An agent-to-agent message as one line: "to"/"from" icon, the agent's name
 * (tap to open that agent), the body's first line and the send time. Tapping
 * the rest of the row shows the full body below it. Mirrors web's
 * AgentMessageCard so a message never reads as something the user typed.
 */
function AgentMessageRow(props: {
  readonly icon: "tray" | "paperplane";
  readonly direction: "from" | "to";
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  /** Shown with the expanded body, where there is room for it. */
  readonly badge: ReactNode;
  readonly body: string;
  readonly iconColor: ColorValue;
  /** Formatted send time, shown at the row's end like normal messages. */
  readonly timeLabel: string;
}) {
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const name = props.name.trim() || "agent";
  const body = props.body.trim();
  const firstLine = useMemo(() => body.split("\n", 1)[0]!.trim(), [body]);
  return (
    <View className="mb-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityHint={expanded ? "Hides the full message." : "Shows the full message."}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-8 flex-row items-center gap-1.5 py-1.5 active:opacity-70"
      >
        <SymbolView name={props.icon} size={13} tintColor={props.iconColor} type="monochrome" />
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${props.direction === "to" ? "To" : "From"} ${name}`}
          accessibilityHint="Opens that agent's thread."
          className="max-w-[45%] shrink-0"
          hitSlop={6}
          onPress={() =>
            // Push, not navigate: navigate reuses this Thread route, so back
            // would skip the thread this message was opened from.
            navigation.dispatch(
              StackActions.push("Thread", {
                environmentId: props.environmentId,
                threadId: props.threadId,
              }),
            )
          }
        >
          <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {firstLine}
        </Text>
        {props.timeLabel ? (
          <Text className="shrink-0 pl-1 text-xs text-foreground-tertiary">{props.timeLabel}</Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View className="gap-1.5 pb-1.5 pl-5">
          {props.badge ? <View className="flex-row items-center">{props.badge}</View> : null}
          {body.length > 0 ? (
            <Text selectable className="text-sm text-foreground">
              {body}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The one row a run of back-to-back agent messages folds into; tap to open or close it. */
export const AgentChatterHeaderRow = memo(function AgentChatterHeaderRow(props: {
  readonly entry: AgentChatterHeaderEntry;
  readonly iconColor: ColorValue;
  /** Receives the state the tap asks for. */
  readonly onToggle: (groupId: string, expanded: boolean) => void;
}) {
  const { entry } = props;
  const label = `${entry.live ? "Agents talking" : "Agents talked"} · ${entry.messageCount} messages`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: entry.expanded }}
      accessibilityLabel={label}
      accessibilityHint={entry.expanded ? "Hides the messages." : "Shows the messages."}
      hitSlop={4}
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle(entry.groupId, !entry.expanded);
      }}
      className="mb-1 min-h-8 flex-row items-center gap-1.5 py-1.5 active:opacity-70"
    >
      <SymbolView name="cpu" size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <ThreadDisclosureChevron
        expanded={entry.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconColor}
      />
    </Pressable>
  );
});

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
    <AgentMessageRow
      icon="tray"
      direction="from"
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
    <AgentMessageRow
      icon="paperplane"
      direction="to"
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

/** A review started from this chat, shown in place of a plain agent row's name and status. */
interface SpawnedReview {
  /** "Deep review". */
  readonly label: string;
  /** Its reviewer or an agent it started is at work (`reviewRunState`). */
  readonly running: boolean;
  /** It sent its final findings (`reviewProgress`). */
  readonly done: boolean;
  readonly onOpen: () => void;
}

function SpawnedAgentRow(props: {
  readonly sent: AgentMessageSentPayload;
  readonly environmentId: EnvironmentId;
}) {
  return props.sent.review === undefined ? (
    <AgentRow {...props} review={null} />
  ) : (
    <ReviewAgentRow {...props} mode={props.sent.review} />
  );
}

/**
 * A review this chat started, as its agent row: named for its depth, running while it or any
 * agent it started works (a reviewer is idle between its agents' answers), timed from its start,
 * and opening its findings rather than the reviewer's chat.
 */
function ReviewAgentRow(props: {
  readonly sent: AgentMessageSentPayload;
  readonly environmentId: EnvironmentId;
  readonly mode: AgentReviewMode;
}) {
  const { sent, environmentId } = props;
  const navigation = useNavigation();
  const ref = useMemo(
    () => scopeThreadRef(environmentId, ThreadId.make(sent.toThreadId)),
    [environmentId, sent.toThreadId],
  );
  const { shell, source } = useReviewThreadFindings(ref);
  const { run } = useReviewerRun(environmentId, shell);
  // Read as its findings screen reads it: a review that sent its final findings is done, even if
  // its reviewer's session errored afterwards (a server restart while its last turn wrapped up).
  const progress =
    run === null ? null : reviewProgress({ run, findings: source?.findings ?? null });
  const chatId = shell?.parentThreadId ?? null;
  const review = useMemo<SpawnedReview>(
    () => ({
      label: agentReviewModeLabel(props.mode),
      running: progress?.kind === "running",
      done: progress?.kind === "done",
      onOpen: () =>
        navigation.navigate("ThreadReviewFindings", {
          environmentId,
          threadId: sent.toThreadId,
          ...(chatId === null ? {} : { fromThreadId: chatId }),
        }),
    }),
    [chatId, environmentId, navigation, progress?.kind, props.mode, sent.toThreadId],
  );
  return <AgentRow sent={sent} environmentId={environmentId} review={review} />;
}

/**
 * A child agent this thread started, on one line like web: provider icon with
 * a status dot, "name: task · status" and elapsed time. Tap opens the agent
 * (a review's findings); the chevron shows its instructions.
 */
function AgentRow(props: {
  readonly sent: AgentMessageSentPayload;
  readonly environmentId: EnvironmentId;
  readonly review: SpawnedReview | null;
}) {
  const { sent, environmentId, review } = props;
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
  const status: SpawnedAgentRowStatus | null =
    review?.running === true
      ? "running"
      : review?.done === true
        ? "done"
        : resolveSpawnedAgentRowStatus(shell, sent.delivery);
  const lastTurn = spawnedAgentElapsedRange(shell);
  const live = status === "running" && lastTurn !== null && lastTurn.endMs === null;
  const nowMs = useVisibleSecondClock(live && review === null);
  // A review's time is the whole review's, in the words its findings use: how long so far by the
  // minute while it runs, how long it took once it is over.
  const reviewNowMs = useMinuteClock(review?.running === true);
  const elapsed =
    review === null
      ? lastTurn !== null && (lastTurn.endMs !== null || live)
        ? formatAgentElapsed((lastTurn.endMs ?? nowMs) - lastTurn.startMs)
        : null
      : shell === null || lastTurn === null
        ? null
        : review.running || lastTurn.endMs === null
          ? formatReviewElapsed(reviewNowMs - Date.parse(shell.createdAt))
          : formatReviewDuration(lastTurn.endMs - Date.parse(shell.createdAt));
  const name = review?.label ?? (shell?.title.trim() || sent.toName.trim() || "Agent");
  const task = review === null ? spawnedAgentTaskTitle(sent) : null;
  const modelLabel = shell ? resolveHomeAgentModelLabel(serverConfigs, shell) : null;
  const statusLabel =
    status === null
      ? null
      : review !== null && status === "running"
        ? "Reviewing"
        : SPAWNED_AGENT_STATUS_LABEL[status];
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
          accessibilityHint={
            review === null ? "Opens that agent's thread." : "Opens the review's findings."
          }
          className="min-w-0 flex-1 active:opacity-70"
          disabled={!shell}
          onPress={
            review?.onOpen ??
            (() =>
              navigation.dispatch(
                StackActions.push("Thread", { environmentId, threadId: sent.toThreadId }),
              ))
          }
        >
          <Text className="text-sm text-foreground" numberOfLines={1}>
            <Text className="font-t3-medium">{task ? `${name}:` : name}</Text>
            {task ? ` ${task}` : ""}
            {review !== null && modelLabel ? ` · ${modelLabel}` : ""}
            {statusLabel ? (
              <Text
                className={cn(
                  "text-foreground-muted",
                  status === "failed" && "text-adaptive-rose-600-400",
                )}
              >
                {` · ${statusLabel}`}
              </Text>
            ) : null}
          </Text>
        </Pressable>
        {elapsed !== null ? (
          <Text className="shrink-0 text-xs text-foreground-tertiary">{elapsed}</Text>
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
          {review !== null && shell ? (
            <Pressable
              accessibilityRole="link"
              accessibilityHint="Opens the reviewer's own chat."
              hitSlop={6}
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("Thread", { environmentId, threadId: sent.toThreadId }),
                )
              }
              className="self-start active:opacity-70"
            >
              <Text className="text-xs text-foreground underline">View agent</Text>
            </Pressable>
          ) : null}
          <Text selectable className="text-sm text-foreground">
            {sent.body.trim()}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
