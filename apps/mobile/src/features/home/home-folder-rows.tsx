import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveAgentControlAvailability } from "@t3tools/client-runtime/state/child-agents";
import { memo, useCallback, useMemo, type ReactNode } from "react";
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
import type { HomeAgentStatus, HomeFolderEdge, HomeStatusFilter } from "./homeFolderList";
import { projectIconColorClassNames } from "../../lib/projectIcon";

/** Folder rows for the project-grouped Home list (see homeFolderList.ts). */

/**
 * One row's slice of its folder card. Rows are virtualized separately, so the
 * card is the sum of slices: side borders on every row, top border and radius
 * on the header, bottom border and radius on the last row.
 */
export function HomeFolderCardSlice(props: {
  readonly edge: HomeFolderEdge | null | undefined;
  readonly children: ReactNode;
}) {
  const edge = props.edge;
  if (!edge) return <>{props.children}</>;
  return (
    <View
      className={cn(
        "mx-3 overflow-hidden border-x border-border-subtle bg-card",
        edge.first && "mt-3 rounded-t-lg border-t",
        edge.last && "mb-1 rounded-b-lg border-b pb-1",
      )}
    >
      {props.children}
    </View>
  );
}

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
  const accent =
    project.projectIcon && "color" in project.projectIcon
      ? projectIconColorClassNames(project.projectIcon.color)
      : null;
  return (
    <View
      className={cn(
        "flex-row items-center pl-3 pr-1",
        props.expanded && "border-b border-border-subtle",
        accent?.background,
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          props.title,
          `${props.count} ${props.count === 1 ? "thread" : "threads"}`,
          props.workingCount > 0 ? `${props.workingCount} working` : null,
        ]
          .filter((part) => part !== null)
          .join(", ")}
        accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the project folder.`}
        accessibilityState={{ expanded: props.expanded }}
        className="min-h-[44px] flex-1 flex-row items-center gap-2"
        onPress={() => onToggle(folderKey)}
        style={pressedOpacity}
      >
        <ProjectFavicon
          environmentId={project.environmentId}
          faviconPath={project.faviconPath}
          projectIcon={project.projectIcon}
          size={18}
          projectTitle={props.title}
          workspaceRoot={project.workspaceRoot}
        />
        <Text
          className={cn("shrink text-sm font-t3-bold", accent?.text ?? "text-foreground")}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.count > 0 ? (
          <Text className="text-xs tabular-nums text-foreground-tertiary">{props.count}</Text>
        ) : null}
        {props.workingCount > 0 ? (
          <View className="flex-row items-center gap-1 rounded-full bg-row-hover px-2 py-0.5">
            <View className="size-1.5 rounded-full bg-adaptive-sky-600-400" />
            <Text className="text-xs tabular-nums text-adaptive-sky-600-400">
              {props.workingCount} working
            </Text>
          </View>
        ) : null}
        <View className="flex-1" />
        <Chevron expanded={props.expanded} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New task in ${props.title}`}
        className="size-11 items-center justify-center"
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
        "min-h-[36px] flex-row items-center gap-1.5 pl-5 pr-4",
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
      className={cn("pr-4", props.muted && "opacity-60")}
    >
      <View
        className="ml-6 min-h-[40px] flex-row items-center gap-2.5 border-l border-border-subtle py-1.5"
        style={{ paddingLeft: 10 + props.depth * CHILD_INDENT }}
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
      className="min-h-[40px] flex-row items-center gap-1.5 border-t border-border-subtle px-4"
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

const STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly id: HomeStatusFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "working", label: "Working" },
  { id: "needs-you", label: "Needs you" },
];

/** Status chips above the folders. Counts count whole trees the chip would keep. */
export const HomeStatusFilterChips = memo(function HomeStatusFilterChips(props: {
  readonly value: HomeStatusFilter;
  readonly counts: Readonly<Record<HomeStatusFilter, number>>;
  readonly onChange: (value: HomeStatusFilter) => void;
}) {
  return (
    <View className="flex-row gap-2 px-4 pb-1 pt-2" accessibilityRole="tablist">
      {STATUS_FILTER_OPTIONS.map((option) => {
        const selected = props.value === option.id;
        const count = props.counts[option.id];
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.id === "all" ? option.label : `${option.label}, ${count}`}
            onPress={() => props.onChange(option.id)}
            hitSlop={6}
            style={pressedOpacity}
            className={cn(
              "flex-row items-center gap-1.5 rounded-md px-3 py-1.5",
              selected ? "bg-foreground" : "bg-row-hover",
            )}
          >
            <Text
              className={cn(
                "text-sm font-t3-medium",
                selected ? "text-screen" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
            {option.id !== "all" && count > 0 ? (
              <Text
                className={cn(
                  "text-xs font-t3-medium tabular-nums",
                  selected
                    ? "text-screen"
                    : option.id === "needs-you"
                      ? "text-warning-foreground"
                      : "text-adaptive-sky-600-400",
                )}
              >
                {count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
});

/** Bottom-left "N agents working" pill; tapping toggles the Working filter. */
export const HomeWorkingPill = memo(function HomeWorkingPill(props: {
  readonly count: number;
  readonly selected: boolean;
  readonly bottom: number;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      accessibilityLabel={`${props.count} ${props.count === 1 ? "agent" : "agents"} working`}
      accessibilityHint={props.selected ? "Shows every thread." : "Shows working threads."}
      onPress={props.onPress}
      style={({ pressed }) => ({ bottom: props.bottom, opacity: pressed ? 0.6 : 1 })}
      className={cn(
        "absolute left-4 flex-row items-center gap-2 rounded-md border px-3 py-2.5",
        props.selected ? "border-foreground bg-foreground" : "border-border bg-card-alt",
      )}
    >
      <View className="size-2 rounded-full bg-adaptive-sky-600-400" />
      <Text
        className={cn(
          "text-sm font-t3-medium tabular-nums",
          props.selected ? "text-screen" : "text-foreground",
        )}
      >
        {props.count} {props.count === 1 ? "agent" : "agents"} working
      </Text>
    </Pressable>
  );
});
