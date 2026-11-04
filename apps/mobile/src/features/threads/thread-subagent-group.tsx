import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { subagentRowState, visibleAgentRows } from "@t3tools/client-runtime/state/subagent-display";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { memo } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { SubagentTurnItem } from "../../lib/threadActivity";
import { environmentAgentControlAtom } from "../../state/agentControl";
import { environmentThreadDetails } from "../../state/threads";
import { openThreadFromThread } from "./openThreadFromThread";
import {
  presentSpawnedAgents,
  type SpawnedAgentRow,
  type SpawnedAgentTone,
} from "./spawnedAgentsPresentation";
import { ShimmeringWorkContent, ThreadDisclosureChevron } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const TONE_DOT_CLASS = {
  working: "bg-adaptive-sky-600-400",
  attention: "bg-adaptive-amber-700-400",
  done: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  quiet: "bg-foreground-muted",
} as const satisfies Record<SpawnedAgentTone, string>;

const TONE_LABEL_CLASS = {
  working: "text-foreground-muted",
  attention: "text-adaptive-amber-700-400",
  done: "text-foreground-muted",
  failed: "text-adaptive-rose-600-400",
  quiet: "text-foreground-muted",
} as const satisfies Record<SpawnedAgentTone, string>;

/**
 * The agents one turn spawned, live in the work log (web's SpawnedAgentLog): a row each with its
 * provider, title, current step, state and elapsed time; tapping a row opens the agent's thread.
 * More than one gets a header that counts them by state and opens the full list. Live state comes
 * from this thread's own projection and agent control, never a subscription per child.
 */
export const ThreadSubagentGroup = memo(function ThreadSubagentGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agents: ReadonlyArray<SubagentTurnItem>;
  readonly expanded: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly onToggle: () => void;
}) {
  const navigation = useNavigation();
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => thread?.projection.subagents,
  );
  const control = useAtomValue(environmentAgentControlAtom(props.environmentId));
  const inputs = props.agents.map((item) => ({
    item,
    live: liveAgents?.find((agent) => agent.id === item.subagentId),
    control: item.childThreadId === null ? undefined : control.get(item.childThreadId),
  }));
  const ticking = inputs.some(
    ({ item, live, control: state }) =>
      subagentRowState(live?.status ?? item.status, state) === "working",
  );
  const nowMs = useVisibleSecondClock(ticking);
  const presentation = presentSpawnedAgents(inputs, nowMs);
  const grouped = presentation.rows.length > 1;
  const { visible, hidden } = props.expanded
    ? { visible: presentation.rows, hidden: 0 }
    : visibleAgentRows(presentation.rows);
  const openAgent = (threadId: ThreadId) =>
    openThreadFromThread(navigation, {
      environmentId: String(props.environmentId),
      threadId: String(threadId),
    });
  const toggle = () => {
    void Haptics.selectionAsync();
    props.onToggle();
  };

  return (
    <View className="-mx-1 mb-1 px-1">
      {grouped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${presentation.heading}, ${presentation.summary}`}
          accessibilityState={{ expanded: props.expanded }}
          hitSlop={4}
          onPress={toggle}
          className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 active:bg-subtle"
        >
          <View className="h-6 w-6 shrink-0 items-center justify-center">
            <SymbolView
              name={{ ios: "sparkles", android: "auto_awesome" }}
              size={14}
              weight="medium"
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
          </View>
          {presentation.working ? (
            // One shimmer per spawn, on its heading; the rows below stay still.
            <ShimmeringWorkContent
              className="flex-none"
              icon="brain"
              iconSubtleColor={props.iconSubtleColor}
              label={presentation.heading}
              showIcon={false}
            />
          ) : (
            <Text
              className={cn(
                "shrink-0 text-sm",
                presentation.active ? "text-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {presentation.heading}
            </Text>
          )}
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {presentation.summary}
          </Text>
          {presentation.elapsed ? (
            <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
              {presentation.elapsed}
            </Text>
          ) : null}
          <ThreadDisclosureChevron
            expanded={props.expanded}
            collapsedDirection="down"
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
      ) : null}
      <View className={grouped ? "ml-3 border-l border-border-subtle pl-2" : undefined}>
        {visible.map((row) => (
          <SpawnedAgentRowView
            key={row.key}
            row={row}
            // A lone agent's title carries the shimmer the header would.
            shimmer={!grouped && row.state === "working"}
            detailLines={props.expanded ? 3 : 1}
            iconSubtleColor={props.iconSubtleColor}
            onOpen={openAgent}
          />
        ))}
        {hidden > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Show ${hidden} more agents`}
            hitSlop={4}
            onPress={toggle}
            className="min-h-8 justify-center rounded-md px-1.5 active:bg-subtle"
          >
            <Text className="text-xs text-foreground-muted">+{hidden} more</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

function SpawnedAgentRowView(props: {
  readonly row: SpawnedAgentRow;
  readonly shimmer: boolean;
  readonly detailLines: number;
  readonly iconSubtleColor: ColorValue;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const threadId = row.childThreadId;
  const status = row.statusLabel ?? "working";
  return (
    <Pressable
      accessibilityRole={threadId === null ? undefined : "button"}
      accessibilityLabel={`${row.title}, ${status}${row.elapsed ? `, ${row.elapsed}` : ""}`}
      accessibilityHint={threadId === null ? undefined : "Opens this agent's thread."}
      disabled={threadId === null}
      hitSlop={2}
      onPress={() => {
        if (threadId !== null) props.onOpen(threadId);
      }}
      className="min-h-11 justify-center gap-0.5 rounded-md px-1.5 py-1 active:bg-subtle"
    >
      <View className="flex-row items-center gap-1.5">
        <View className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[row.tone])} />
        <View accessible={false} className="shrink-0">
          <ProviderIcon provider={row.driver} size={13} />
        </View>
        {props.shimmer ? (
          <ShimmeringWorkContent
            icon="brain"
            iconSubtleColor={props.iconSubtleColor}
            label={row.title}
            showIcon={false}
          />
        ) : (
          <Text
            className={cn(
              "min-w-0 flex-1 text-sm",
              row.tone === "quiet" ? "text-foreground-muted" : "text-foreground",
            )}
            numberOfLines={1}
          >
            {row.title}
          </Text>
        )}
        {row.statusLabel ? (
          <Text className={cn("shrink-0 text-xs", TONE_LABEL_CLASS[row.tone])}>
            {row.statusLabel}
          </Text>
        ) : null}
        {row.elapsed ? (
          <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{row.elapsed}</Text>
        ) : null}
        {threadId !== null ? (
          <SymbolView
            name="chevron.right"
            size={10}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        ) : null}
      </View>
      {row.detail ? (
        <Text className="pl-3 text-xs text-foreground-muted" numberOfLines={props.detailLines}>
          {row.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}
