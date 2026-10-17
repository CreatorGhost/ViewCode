import type { EnvironmentThreadShell } from "@t3tools/client-runtime/viewcodeThread";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveAgentControlAvailability } from "@t3tools/client-runtime/state/child-agents";
import {
  AGENT_STATUS_GROUP_LABEL,
  DEFAULT_FOLDER_SORT_ORDER,
  FOLDER_SORT_ORDER_LABEL,
  FOLDER_SORT_ORDERS,
  type AgentStatusGroup,
  type FolderSortOrder,
} from "@t3tools/client-runtime/state/thread-arrangement";
import type { MenuAction } from "@react-native-menu/menu";
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
import { AGENT_STATUS } from "../agents/agentStatus";
import type { HomeAgentStatus, HomeFolderEdge, HomeStatusFilter } from "./homeFolderList";
import { projectIconColorClassNames } from "../../lib/projectIcon";

/** Folder rows for the project-grouped Home list (see homeFolderList.ts). */

/**
 * One row's slice of its folder card. Rows are virtualized separately, so the
 * card is the sum of slices: the top radius on the header, the bottom radius
 * on the last row.
 */
export function HomeFolderCardSlice(props: {
  readonly edge: HomeFolderEdge | null | undefined;
  readonly children: ReactNode;
}) {
  const edge = props.edge;
  if (!edge) return <>{props.children}</>;
  // A borderless tonal card per folder, so it is clear which folder a row belongs to.
  return (
    <View
      className={cn(
        "mx-3 overflow-hidden bg-card",
        edge.first && "mt-3 rounded-t-3xl pt-1",
        edge.last && "mb-1 rounded-b-3xl pb-2",
      )}
      // Slices are laid out apart; sub-pixel rounding leaves a hairline of
      // screen between them. Reaching 1dp up keeps the card one surface.
      style={edge.first ? undefined : { marginTop: -1, paddingTop: 1 }}
    >
      {props.children}
    </View>
  );
}

// The folder title spans the header, so its long-press menu wrapper must too.
const FOLDER_TITLE_MENU_STYLE = { flex: 1 } as const;

const pressedOpacity = ({ pressed }: { readonly pressed: boolean }) => ({
  opacity: pressed ? 0.6 : 1,
});

/** Swaps glyphs rather than rotating: a transformed Tabler SVG on Android
    rotates out of its own viewport and vanishes. */
function Chevron(props: { readonly expanded: boolean; readonly size?: number }) {
  return (
    <SymbolView
      name={props.expanded ? "chevron.down" : "chevron.right"}
      size={props.size ?? 11}
      tintColorClassName="accent-foreground-muted"
      type="monochrome"
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
  readonly sortOrder: FolderSortOrder;
  readonly onToggle: (folderKey: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
  readonly onSortChange: (folderKey: string, order: FolderSortOrder) => void;
}) {
  const { folderKey, onToggle, onNewThread, onSortChange, project } = props;
  const sortActions = useMemo<MenuAction[]>(
    () =>
      FOLDER_SORT_ORDERS.map((order) => ({
        id: `sort:${order}`,
        title: `Sort by ${FOLDER_SORT_ORDER_LABEL[order].toLowerCase()}`,
        state: order === props.sortOrder ? ("on" as const) : ("off" as const),
      })),
    [props.sortOrder],
  );
  const handleSortAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const order = FOLDER_SORT_ORDERS.find(
        (candidate) => nativeEvent.event === `sort:${candidate}`,
      );
      if (order) onSortChange(folderKey, order);
    },
    [folderKey, onSortChange],
  );
  // The project colour, else the icon's colour, tints the header; the bar marks a project colour.
  const accentColor =
    project.projectColor ??
    (project.projectIcon && "color" in project.projectIcon ? project.projectIcon.color : null);
  const accent = accentColor ? projectIconColorClassNames(accentColor) : null;
  // Folders read as flat sections of their card: the colour tints the label, not a band.
  return (
    <View className="flex-row items-center pl-6 pr-1">
      {project.projectColor ? (
        <View
          className={cn(
            "absolute top-2 bottom-2 left-3 w-[3px] rounded-full",
            projectIconColorClassNames(project.projectColor).swatch,
          )}
        />
      ) : null}
      <ControlPillMenu
        actions={sortActions}
        onPressAction={handleSortAction}
        shouldOpenOnLongPress
        title={`Sort ${props.title}`}
        style={FOLDER_TITLE_MENU_STYLE}
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
          accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the project folder. Long-press to sort it.`}
          accessibilityState={{ expanded: props.expanded }}
          className="min-h-[44px] flex-1 flex-row items-center gap-2"
          onPress={() => onToggle(folderKey)}
          style={pressedOpacity}
        >
          <ProjectFavicon
            environmentId={project.environmentId}
            faviconPath={project.faviconPath}
            projectIcon={project.projectIcon}
            size={16}
            projectTitle={props.title}
            workspaceRoot={project.workspaceRoot}
          />
          <Text
            className={cn("shrink text-sm font-t3-medium", accent?.text ?? "text-foreground-muted")}
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
          {props.sortOrder !== DEFAULT_FOLDER_SORT_ORDER ? (
            <Text className="text-xs text-foreground-tertiary">
              {FOLDER_SORT_ORDER_LABEL[props.sortOrder]}
            </Text>
          ) : null}
          <Chevron expanded={props.expanded} />
        </Pressable>
      </ControlPillMenu>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New task in ${props.title}`}
        className="size-[44px] items-center justify-center"
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
        "min-h-[44px] flex-row items-center gap-1.5 pl-6 pr-4",
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

const AGENT_GROUP_DOT_CLASS: Record<AgentStatusGroup, string> = {
  working: "bg-adaptive-sky-600-400",
  "needs-you": "bg-adaptive-amber-700-400",
  failed: "bg-adaptive-rose-600-400",
  done: "bg-foreground-muted",
};

/** The label above one status group of a lead's agents. */
export const HomeFolderAgentGroupLabel = memo(function HomeFolderAgentGroupLabel(props: {
  readonly group: AgentStatusGroup;
  readonly muted: boolean;
}) {
  return (
    <View
      accessibilityRole="header"
      className={cn("flex-row items-center gap-1.5 pt-2 pb-1 pl-8", props.muted && "opacity-60")}
    >
      <View className={cn("size-1.5 rounded-full", AGENT_GROUP_DOT_CLASS[props.group])} />
      <Text className="text-xs font-t3-medium uppercase text-foreground-tertiary">
        {AGENT_STATUS_GROUP_LABEL[props.group]}
      </Text>
    </View>
  );
});

/** "Done (N)": a lead's finished agents, folded until tapped. */
export const HomeFolderAgentsDoneRow = memo(function HomeFolderAgentsDoneRow(props: {
  readonly leadKey: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly muted: boolean;
  readonly onToggle: (leadKey: string) => void;
}) {
  const { leadKey, onToggle } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.count} done ${props.count === 1 ? "agent" : "agents"}`}
      accessibilityHint={`${props.expanded ? "Hides" : "Shows"} the agents that finished.`}
      accessibilityState={{ expanded: props.expanded }}
      className={cn(
        "min-h-[44px] flex-row items-center gap-1.5 pl-8 pr-4",
        props.muted && "opacity-60",
      )}
      onPress={() => onToggle(leadKey)}
      style={pressedOpacity}
    >
      <Chevron expanded={props.expanded} size={10} />
      <Text className="text-xs font-t3-medium text-foreground-muted">Done ({props.count})</Text>
    </Pressable>
  );
});

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
  const statusText = paused ? pausedAgentLabel(props.queued) : AGENT_STATUS[props.status].label;
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
        className="ml-8 min-h-[44px] flex-row items-center gap-2.5 border-l border-border-subtle py-1.5"
        style={{ paddingLeft: 10 + props.depth * CHILD_INDENT }}
      >
        <View className={cn("size-2 rounded-full", AGENT_STATUS[props.status].dotClass)} />
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
      className="min-h-[44px] flex-row items-center gap-1.5 px-6"
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
    <View className="flex-row gap-2 px-6 pb-1 pt-2" accessibilityRole="tablist">
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
            // 31dp chips reach 45dp with the slop, without a taller header.
            hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
            style={pressedOpacity}
            className={cn(
              "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
              selected ? "border-foreground bg-foreground" : "border-border-subtle bg-card",
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
