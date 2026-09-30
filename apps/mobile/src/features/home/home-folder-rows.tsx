import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveAgentControlAvailability } from "@t3tools/client-runtime/state/child-agents";
import { memo, useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import {
  type AgentMenuEvent,
  buildChildAgentMenuActions,
  isAgentMenuEvent,
  pausedAgentLabel,
} from "../agents/agentMenus";
import type { HomeAgentStatus } from "./homeFolderList";

/** Folder rows for the project-grouped Home list (see homeFolderList.ts). */

const pressedOpacity = ({ pressed }: { readonly pressed: boolean }) => ({
  opacity: pressed ? 0.6 : 1,
});

function Chevron(props: { readonly expanded: boolean; readonly size?: number }) {
  return (
    <SymbolView
      name="chevron.right"
      size={props.size ?? 11}
      tintColorClassName="accent-foreground-muted"
      type="monochrome"
      style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
    />
  );
}

export const HomeFolderHeader = memo(function HomeFolderHeader(props: {
  readonly folderKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly count: number;
  readonly workingCount: number;
  readonly expanded: boolean;
  readonly onToggle: (folderKey: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { folderKey, onToggle, onNewThread, project } = props;
  return (
    <View className="mt-3 flex-row items-center pl-5 pr-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.title}, ${props.count} ${props.count === 1 ? "thread" : "threads"}`}
        accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the project folder.`}
        accessibilityState={{ expanded: props.expanded }}
        className="min-h-[40px] flex-1 flex-row items-center gap-2"
        onPress={() => onToggle(folderKey)}
        style={pressedOpacity}
      >
        <Chevron expanded={props.expanded} />
        <ProjectFavicon
          environmentId={project.environmentId}
          faviconPath={project.faviconPath}
          projectIcon={project.projectIcon}
          size={16}
          projectTitle={props.title}
          workspaceRoot={project.workspaceRoot}
        />
        <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-tertiary">{props.count}</Text>
        {props.workingCount > 0 ? (
          <View
            className="flex-row items-center gap-1"
            accessibilityLabel={`${props.workingCount} working`}
          >
            <View className="size-1.5 rounded-full bg-adaptive-sky-600-400" />
            <Text className="text-xs tabular-nums text-adaptive-sky-600-400">
              {props.workingCount}
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New task in ${props.title}`}
        className="size-10 items-center justify-center"
        hitSlop={4}
        onPress={() => onNewThread(project)}
        style={pressedOpacity}
      >
        <SymbolView
          name="plus"
          size={15}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
});

export const HomeFolderAgentsToggle = memo(function HomeFolderAgentsToggle(props: {
  readonly leadKey: string;
  readonly agentCount: number;
  readonly workingCount: number;
  readonly pausedCount: number;
  readonly expanded: boolean;
  readonly muted: boolean;
  readonly onToggle: (leadKey: string) => void;
}) {
  const { leadKey, onToggle } = props;
  const label = `${props.agentCount} ${props.agentCount === 1 ? "agent" : "agents"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        label,
        props.workingCount > 0 ? `${props.workingCount} working` : null,
        props.pausedCount > 0 ? `${props.pausedCount} paused` : null,
      ]
        .filter((part) => part !== null)
        .join(", ")}
      accessibilityHint={`${props.expanded ? "Hides" : "Shows"} the agents this thread started.`}
      accessibilityState={{ expanded: props.expanded }}
      className={cn(
        "min-h-[32px] flex-row items-center gap-1.5 pl-9 pr-5",
        props.muted && "opacity-60",
      )}
      onPress={() => onToggle(leadKey)}
      style={pressedOpacity}
    >
      <Chevron expanded={props.expanded} size={10} />
      <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
      {props.workingCount > 0 ? (
        <Text className="text-xs text-adaptive-sky-600-400">· {props.workingCount} working</Text>
      ) : null}
      {props.pausedCount > 0 ? (
        <Text className="text-xs text-adaptive-amber-700-400">· {props.pausedCount} paused</Text>
      ) : null}
    </Pressable>
  );
});

const STATUS_DOT_CLASS = {
  "needs-you": "bg-adaptive-amber-700-400",
  working: "bg-adaptive-sky-600-400",
  paused: "bg-adaptive-amber-700-400",
  failed: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
  idle: "bg-adaptive-emerald-600-400",
} as const satisfies Record<HomeAgentStatus, string>;

const STATUS_LABEL = {
  "needs-you": "needs you",
  working: "working",
  paused: "paused",
  failed: "failed",
  stopped: "stopped",
  idle: "idle",
} as const satisfies Record<HomeAgentStatus, string>;

/** Indent per nesting level below the lead, in dp. */
const CHILD_INDENT = 14;

/** A child agent: tap opens it, long-press offers Stop, Resume and Discard. */
export const HomeFolderChildRow = memo(function HomeFolderChildRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly status: HomeAgentStatus;
  readonly running: boolean;
  readonly queued: number;
  readonly modelLabel: string | null;
  readonly muted: boolean;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onAgentMenuEvent: (thread: EnvironmentThreadShell, event: AgentMenuEvent) => void;
}) {
  const { thread, onSelectThread, onAgentMenuEvent } = props;
  const paused = props.status === "paused";
  const menuActions = useMemo(
    () =>
      buildChildAgentMenuActions(
        resolveAgentControlAvailability({
          running: props.running,
          control: { paused, queued: props.queued },
        }),
      ),
    [paused, props.queued, props.running],
  );
  const statusText = paused ? pausedAgentLabel(props.queued) : STATUS_LABEL[props.status];
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (isAgentMenuEvent(nativeEvent.event)) onAgentMenuEvent(thread, nativeEvent.event);
    },
    [onAgentMenuEvent, thread],
  );
  const row = (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${statusText}${props.modelLabel ? `, ${props.modelLabel}` : ""}`}
      accessibilityHint={
        menuActions.length > 0 ? "Opens the agent. Long-press to stop or resume it." : undefined
      }
      onPress={() => onSelectThread(thread)}
      className={cn("pr-5", props.muted && "opacity-60")}
    >
      <View
        className="min-h-[40px] flex-row items-center gap-2.5 py-1.5"
        style={{ paddingLeft: 24 + props.depth * CHILD_INDENT }}
      >
        <View className={cn("size-2 rounded-full", STATUS_DOT_CLASS[props.status])} />
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {thread.title}
        </Text>
        {paused ? (
          <Text className="text-xs text-adaptive-amber-700-400" numberOfLines={1}>
            {statusText}
          </Text>
        ) : null}
        {props.modelLabel ? (
          <Text className="max-w-[40%] text-xs text-foreground-tertiary" numberOfLines={1}>
            {props.modelLabel}
          </Text>
        ) : null}
      </View>
    </RowPressable>
  );
  if (menuActions.length === 0) return row;
  return (
    <ControlPillMenu
      actions={menuActions}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
      title={thread.title}
    >
      {row}
    </ControlPillMenu>
  );
});

export const HomeFolderSettledRow = memo(function HomeFolderSettledRow(props: {
  readonly folderKey: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: (folderKey: string) => void;
}) {
  const { folderKey, onToggle } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.count} settled ${props.count === 1 ? "thread" : "threads"}`}
      accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the settled threads.`}
      accessibilityState={{ expanded: props.expanded }}
      className="min-h-[36px] flex-row items-center gap-1.5 px-5"
      onPress={() => onToggle(folderKey)}
      style={pressedOpacity}
    >
      <Chevron expanded={props.expanded} size={10} />
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        Settled · {props.count}
      </Text>
    </Pressable>
  );
});
