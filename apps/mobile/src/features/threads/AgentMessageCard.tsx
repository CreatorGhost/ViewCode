import type { EnvironmentId } from "@t3tools/contracts";
import type { AgentMessageEnvelope, AgentMessageSentPayload } from "@t3tools/shared/agentMessages";
import { useNavigation } from "@react-navigation/native";
import { memo, useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

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
  const spawn = sent.kind === "spawn";
  return (
    <AgentMessageCardFrame
      icon={spawn ? "cpu" : "paperplane"}
      verb={spawn ? "Started" : "to"}
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
