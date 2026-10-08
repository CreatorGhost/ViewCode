import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import { computeThreadMoveAvailability } from "../threads/threadOrder";
import { LegendList } from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useThreadSearch } from "../../state/queries";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { usePendingThreadOrder } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import { getThreadListV2OrderedSection } from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import {
  HomeFolderAgentsToggle,
  HomeFolderCardSlice,
  HomeFolderChildRow,
  HomeFolderHeader,
  HomeFolderSettledRow,
} from "./home-folder-rows";
import {
  buildHomeFolderList,
  countHomeStatusFilters,
  homeFolderListItemsAreEqual,
  resolveHomeAgentModelLabel,
  type HomeFolderListItem,
  type HomeStatusFilter,
} from "./homeFolderList";
import { HomeStatusFilterChips } from "./home-folder-rows";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectSortOrder,
} from "./homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { buildLeadAgentMenuActions, isAgentMenuEvent } from "../agents/agentMenus";
import { useAgentControlActions } from "../agents/useAgentControlActions";
import { useAgentControlByThreadKey } from "../../state/agentControl";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";
import { HOME_COMPOSER_CLEARANCE } from "./HomeComposerLauncher";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSetThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

// v2 rows are mixed-height: settled slim rows run ~60dp, single-line cards
// measured ~74dp on device (252px on the Pixel 10 Pro screenshot), two-line
// cards ~94dp. The estimate seeds the recycler's initial container count,
// `ceil((scrollLength + 2 * INITIAL_DRAW_DISTANCE) / estimate)` with the
// initial draw distance capped at 50, so an estimate at or below the average
// row height starts the pool at or above the item count for the short lists
// that LegendList otherwise keeps pooling to exactly its item count — that is
// what stopped the dev-mode "no unused container available" warning on the
// seeded short-list device passes. It is a mitigation, not an elimination:
// after first layout the full drawDistance applies, and a sudden expansion
// past the pooled headroom (~25+ items appearing at once) still creates a
// container on demand with the dev-only warning one pass ahead of the
// measured-height pool expansion. The old tallest-card estimate (~92) fired
// that warning on every ordinary shelf expand, so the average wins.
const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 72;
const PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT = 44;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error" ||
      catalogState.connectionState === "unsupported") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title:
        catalogState.connectionState === "unsupported"
          ? "Client not supported"
          : "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

function toggleSetKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const windowHeight = useWindowDimensions().height;
  const { scale } = useAndroidControlSizing();
  const iosBottomToolbarClearance =
    Platform.OS === "ios" && !NATIVE_LIQUID_GLASS_SUPPORTED
      ? PRE_LIQUID_GLASS_BOTTOM_TOOLBAR_HEIGHT
      : 0;
  const searchEnvironmentIds = useMemo(
    () =>
      props.selectedEnvironmentId === null
        ? props.environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : props.environments.some(
              (environment) =>
                environment.environmentId === props.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [props.selectedEnvironmentId]
          : [],
    [props.environments, props.selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onMaterialFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        environmentId: props.selectedEnvironmentId,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects, props.selectedEnvironmentId],
  );
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const v2ProjectScopeKey = props.selectedProjectKey;
  const v2ScopeProjects = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: projectScopes,
        threads: props.threads,
        pendingTasks: props.pendingTasks,
        projectSortOrder: props.projectSortOrder,
      }),
    [
      props.pendingTasks,
      props.projects,
      props.projectSortOrder,
      props.selectedEnvironmentId,
      props.threads,
      projectScopes,
    ],
  );
  const v2ScopedProjectGroup = useMemo(
    () =>
      v2ProjectScopeKey === null
        ? null
        : (v2ScopeProjects.find(
            (scope) =>
              scope.key === v2ProjectScopeKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  v2ProjectScopeKey,
              ),
          ) ?? null),
    [v2ProjectScopeKey, v2ScopeProjects],
  );
  const v2ProjectTitleByProjectKey = useMemo(
    () =>
      new Map(
        v2ScopeProjects.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [v2ScopeProjects],
  );
  const v2ScopedProjectKeys = useMemo(
    () =>
      v2ScopedProjectGroup === null
        ? null
        : new Set(
            v2ScopedProjectGroup.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [v2ScopedProjectGroup],
  );
  // Thread List v2 (beta): one flat list in creation order, no grouping.
  // Settled threads collapse into a recency tail below the card block.
  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells — no snapshot merging or
  // optimistic holds.
  const handleSettleThread = props.onSettleThread;
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMoveThread = useCallback(
    (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
      void props.onMoveThread(thread, direction);
    },
    [props.onMoveThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleSetThreadAutoSettle = useCallback(
    (thread: EnvironmentThreadShell, enabled: boolean) => {
      void props.onSetThreadAutoSettle(thread, enabled);
    },
    [props.onSetThreadAutoSettle],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleRenameThread = useCallback(
    (thread: EnvironmentThreadShell) => props.onRenameThread(thread),
    [props.onRenameThread],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;
  // ViewCode: Home groups threads into project folders (homeFolderList.ts).
  // Folder, agent and per-folder Settled disclosure live for the session.
  const [collapsedFolderKeys, setCollapsedFolderKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedLeadKeys, setExpandedLeadKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<HomeStatusFilter>("all");
  const [expandedSettledFolderKeys, setExpandedSettledFolderKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleFolder = useCallback(
    (key: string) => setCollapsedFolderKeys((keys) => toggleSetKey(keys, key)),
    [],
  );
  const toggleLeadAgents = useCallback(
    (key: string) => setExpandedLeadKeys((keys) => toggleSetKey(keys, key)),
    [],
  );
  const toggleFolderSettled = useCallback(
    (key: string) => setExpandedSettledFolderKeys((keys) => toggleSetKey(keys, key)),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on enable or focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, []),
  );
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  // Agent control is only followed where agent trees exist.
  const agentEnvironmentIds = useMemo(() => {
    const ids = new Set<EnvironmentId>();
    for (const thread of props.threads) {
      if (thread.parentThreadId != null && thread.archivedAt === null) {
        ids.add(thread.environmentId);
      }
    }
    return ids;
  }, [props.threads]);
  const agentControl = useAgentControlByThreadKey(agentEnvironmentIds);
  const agentActions = useAgentControlActions();
  const handleAgentMenuEvent = useCallback(
    (thread: EnvironmentThreadShell, event: string) => {
      if (isAgentMenuEvent(event)) agentActions.runMenuEvent(thread, event);
    },
    [agentActions],
  );
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const autoSettleOptOutEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadAutoSettleOptOut === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const activeReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadActiveReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const machineByEnvironmentId = useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    [serverConfigs],
  );
  // Reference-stable provider glyphs: a fresh object per render would break
  // the memoized rows' props comparison on every parent render.
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(serverConfigs);
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  // Up/down menu availability for every card, computed once per section per
  // rebuild (see computeThreadMoveAvailability): per-thread planner calls made
  // list construction quadratic, and this list rebuilds on every minute tick.
  const threadMoveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: props.threads,
        section,
        pendingOrder,
        reorderableEnvironmentIds: new Set(
          [...serverConfigs].flatMap(([id, config]) =>
            (section === "pinned"
              ? config.environment.capabilities.threadPinReorder
              : config.environment.capabilities.threadActiveReorder) === true
              ? [id]
              : [],
          ),
        ),
        ordered: getThreadListV2OrderedSection({
          threads: props.threads,
          section,
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    return new Map([...sectionAvailability("pinned"), ...sectionAvailability("active")]);
  }, [
    serverConfigs,
    props.threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    nowMinute,
    snoozeWakeTick,
  ]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below the active block and stay visible and deletable
  // while their environment is offline. Same environment scope and search
  // filter as the list itself.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      props.pendingTasks.filter(
        (pendingTask) =>
          (props.selectedEnvironmentId === null ||
            pendingTask.environmentId === props.selectedEnvironmentId) &&
          (v2ScopedProjectKeys === null ||
            v2ScopedProjectKeys.has(
              scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
            )) &&
          (v2SearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
      ),
    [props.pendingTasks, props.selectedEnvironmentId, v2ScopedProjectKeys, v2SearchQuery],
  );
  const folderScopes = useMemo(
    () => (v2ScopedProjectGroup === null ? v2ScopeProjects : [v2ScopedProjectGroup]),
    [v2ScopeProjects, v2ScopedProjectGroup],
  );
  const folderList = useMemo(
    () =>
      buildHomeFolderList({
        // Settled threads are live shells; archived threads keep their
        // original "hidden from lists" meaning.
        // Side chats live in a desktop/web dock; mobile has none, so it hides them.
        threads: props.threads.filter(
          (thread) => thread.archivedAt === null && thread.kind !== "sidechat",
        ),
        scopes: folderScopes,
        projectScoped: v2ScopedProjectGroup !== null,
        pendingTasks: v2PendingTasks,
        environmentId: props.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        statusFilter,
        matchedThreadKeys,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        pendingOrder,
        now: new Date().toISOString(),
        collapsedFolderKeys,
        expandedLeadKeys,
        expandedSettledFolderKeys,
        snoozedShelfExpanded,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
        moveAvailability: threadMoveAvailability,
        shelfPreferencesLoading: !shelfPreferencesLoaded,
        agentControl,
      }),
    [
      agentControl,
      collapsedFolderKeys,
      expandedLeadKeys,
      expandedSettledFolderKeys,
      folderScopes,
      v2ScopedProjectGroup,
      matchedThreadKeys,
      nowMinute,
      pendingOrder,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threads,
      queuedThreadKeys,
      settlementEnvironmentIds,
      shelfPreferencesLoaded,
      snoozeEnvironmentIds,
      snoozeWakeTick,
      snoozedShelfExpanded,
      statusFilter,
      threadMoveAvailability,
      v2PendingTasks,
    ],
  );
  const folderItems = folderList.items;
  const leadEntries = useMemo(
    () => folderItems.flatMap((item) => (item.type === "folder-lead" ? [item.entry] : [])),
    [folderItems],
  );
  const modelLabelOf = useCallback(
    (thread: EnvironmentThreadShell) => resolveHomeAgentModelLabel(serverConfigs, thread),
    [serverConfigs],
  );
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = folderList.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);

  useThreadJumpShortcuts(leadEntries, props.onSelectThread);

  const renderV2Item = useCallback(
    ({ item: listItem }: { readonly item: HomeFolderListItem }) => {
      switch (listItem.type) {
        case "folder-header":
          return (
            <HomeFolderCardSlice edge={listItem.folderEdge}>
              <HomeFolderHeader
                folderKey={listItem.folderKey}
                title={listItem.title}
                project={listItem.scope.representative}
                count={listItem.count}
                workingCount={listItem.workingCount}
                expanded={listItem.expanded}
                onToggle={toggleFolder}
                onNewThread={props.onNewThreadInProject}
              />
            </HomeFolderCardSlice>
          );
        case "folder-agents":
          return (
            <HomeFolderCardSlice edge={listItem.folderEdge}>
              <HomeFolderAgentsToggle
                leadKey={listItem.leadKey}
                agentCount={listItem.agentCount}
                workingCount={listItem.workingCount}
                pausedCount={listItem.pausedCount}
                expanded={listItem.expanded}
                muted={listItem.muted}
                onToggle={toggleLeadAgents}
              />
            </HomeFolderCardSlice>
          );
        case "folder-child":
          return (
            <HomeFolderCardSlice edge={listItem.folderEdge}>
              <HomeFolderChildRow
                thread={listItem.thread}
                depth={listItem.depth}
                status={listItem.status}
                running={listItem.running}
                queued={listItem.queued}
                modelLabel={modelLabelOf(listItem.thread)}
                muted={listItem.muted}
                onSelectThread={props.onSelectThread}
                onAgentMenuEvent={agentActions.runMenuEvent}
              />
            </HomeFolderCardSlice>
          );
        case "folder-settled":
          return (
            <HomeFolderCardSlice edge={listItem.folderEdge}>
              <HomeFolderSettledRow
                folderKey={listItem.folderKey}
                count={listItem.count}
                expanded={listItem.expanded}
                onToggle={toggleFolderSettled}
              />
            </HomeFolderCardSlice>
          );
      }
      const item = listItem.type === "folder-lead" ? listItem.entry : listItem;
      // Inside a folder the row's project line would repeat the folder name.
      const inFolder = listItem.type === "folder-lead" && listItem.inFolder;
      const agentTree = listItem.type === "folder-lead" ? listItem.agentTree : null;
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ??
                  null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={item.showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      const thread = item.item.thread;
      const folderEdge = listItem.type === "folder-lead" ? listItem.folderEdge : null;
      return (
        <HomeFolderCardSlice edge={folderEdge}>
          <ThreadListV2Row
            inFolderCard={folderEdge != null}
            foldedAgentCount={listItem.type === "folder-lead" ? listItem.foldedAgentCount : 0}
            onNewThreadOnBranch={props.onNewThreadOnBranch}
            thread={thread}
            variant={item.item.variant}
            hasQueuedMessages={item.hasQueuedMessages}
            snoozed={item.item.snoozed}
            pinned={item.item.pinned}
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            showTrailingDivider={item.showTrailingDivider}
            project={
              inFolder
                ? null
                : (projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ??
                  null)
            }
            projectTitle={
              inFolder
                ? ""
                : v2ProjectTitleByProjectKey.get(
                    scopedProjectKey(thread.environmentId, thread.projectId),
                  )
            }
            providerInstance={resolveProviderInstance(thread)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
            searchMatch={threadSearchMatchByKey.get(
              threadSearchMatchKey({
                environmentId: thread.environmentId,
                threadId: thread.id,
              }),
            )}
            searchQuery={props.searchQuery}
            onSelectThread={props.onSelectThread}
            onDeleteThread={handleDeleteThread}
            onArchiveThread={props.onArchiveThread}
            onRenameThread={handleRenameThread}
            onRegenerateThreadTitle={handleRegenerateThreadTitle}
            titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
            settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
            onSettleThread={handleSettleThread}
            snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
            pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
            autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
            reorderSupported={
              item.item.pinned
                ? pinReorderEnvironmentIds.has(thread.environmentId)
                : activeReorderEnvironmentIds.has(thread.environmentId)
            }
            canMoveUp={item.canMoveUp}
            canMoveDown={item.canMoveDown}
            onSnoozeThread={handleSnoozeThread}
            onUnsnoozeThread={handleUnsnoozeThread}
            onUnsettleThread={handleUnsettleThread}
            onPinThread={handlePinThread}
            onUnpinThread={handleUnpinThread}
            onSetThreadAutoSettle={handleSetThreadAutoSettle}
            onMoveThread={handleMoveThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            leadingMenuActions={buildLeadAgentMenuActions(agentTree)}
            onLeadingMenuAction={handleAgentMenuEvent}
          />
        </HomeFolderCardSlice>
      );
    },
    [
      agentActions.runMenuEvent,
      handleAgentMenuEvent,
      handleDeleteThread,
      activeReorderEnvironmentIds,
      handleMoveThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleRenameThread,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      handleSetThreadAutoSettle,
      autoSettleOptOutEnvironmentIds,
      pinningEnvironmentIds,
      machineByEnvironmentId,
      pinReorderEnvironmentIds,
      projectByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.onNewThreadOnBranch,
      props.savedConnectionsById,
      resolveProviderInstance,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleFolder,
      toggleFolderSettled,
      toggleLeadAgents,
      toggleSnoozedShelf,
      modelLabelOf,
      props.onNewThreadInProject,
      v2ProjectTitleByProjectKey,
      props.searchQuery,
    ],
  );
  const v2KeyExtractor = useCallback((item: HomeFolderListItem) => item.key, []);

  // FlatList/LegendList treat a changed extraData identity as "re-render every
  // visible row", so an inline object literal would invalidate all rows on
  // every HomeScreen render — and the minute clock must stay out of it for
  // the same reason: the clock text is precomputed per item instead.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      serverConfigs,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      threadSearchMatchByKey,
    }),
    [
      projectByKey,
      props.searchQuery,
      props.savedConnectionsById,
      serverConfigs,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
    ],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No threads yet". Settled threads are unarchived live shells,
  // so the archived-at check already covers the settled shelf.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const statusFilterCounts = useMemo(
    () =>
      countHomeStatusFilters(
        props.threads.filter(
          (thread) =>
            thread.archivedAt === null &&
            (props.selectedEnvironmentId === null ||
              thread.environmentId === props.selectedEnvironmentId),
        ),
      ),
    [props.selectedEnvironmentId, props.threads],
  );
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    return (
      <View className="flex-1 bg-screen">
        <View
          className="flex-1 items-center justify-center bg-screen px-8"
          style={{
            paddingBottom: Math.max(insets.bottom, 24) + iosBottomToolbarClearance,
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
          }}
        >
          <View className="w-full max-w-[430px]">
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
              onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
              action={
                Platform.OS === "android" && !props.catalogState.hasReadyEnvironment ? (
                  <MaterialFloatingActionButton
                    label="Add environment"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={props.onAddConnection}
                  />
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <ActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  // Project and environment scoping stay in the header menu; the chips filter
  // by what the work needs.
  // Android's top bar already names the scope, so the chips lead the list.
  const v2ListHeader = hasAnyThreads ? (
    <HomeStatusFilterChips
      value={statusFilter}
      counts={statusFilterCounts}
      onChange={setStatusFilter}
    />
  ) : Platform.OS === "ios" ? null : (
    <HomeTopContentSpacer />
  );

  // Use the v2 project scope for its empty state. Snoozed threads need no
  // special empty state: their shelf header is a list row even while collapsed.
  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState
        title="No results"
        detail={`No threads matching "${props.searchQuery}".`}
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : statusFilter !== "all" ? (
      // Centred in the space under the chips rather than hugging them.
      <View className="justify-center" style={{ minHeight: Math.round(windowHeight * 0.5) }}>
        <EmptyState
          title={statusFilter === "working" ? "Nothing working" : "Nothing needs you"}
          detail={
            statusFilter === "working"
              ? "No agents are working right now."
              : "No approvals, questions or failures are waiting."
          }
          actionLabel="Show all threads"
          onAction={() => setStatusFilter("all")}
          variant={Platform.OS === "android" ? "plain" : undefined}
        />
      </View>
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No threads in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No threads in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or create a new task."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : (
      <EmptyState
        title="No threads yet"
        detail="Create a task to start a new coding session."
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    );

  // A filter chip that empties the list keeps the list (and its chips) so the
  // user can switch back.
  if (Platform.OS === "android" && folderItems.length === 0 && statusFilter === "all") {
    return (
      <View className="flex-1 bg-screen">
        <View
          className="flex-1 items-center justify-center bg-screen px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          {v2ListEmpty}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      <View className="flex-1 bg-screen">
        {/* Shared with the iPad sidebar: cells are reused across data
            rebuilds and `itemsAreEqual` keeps a minute tick (or an unrelated
            shell update) from re-rendering untouched rows. */}
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <LegendList
            data={folderItems}
            renderItem={renderV2Item}
            keyExtractor={v2KeyExtractor}
            getItemType={(item) => item.type}
            itemsAreEqual={homeFolderListItemsAreEqual}
            estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
            drawDistance={500}
            recycleItems
            extraData={v2ExtraData}
            ListHeaderComponent={v2ListHeader}
            ListEmptyComponent={v2ListEmpty}
            style={{ flex: 1 }}
            automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
            contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            {...scrollGateHandlers}
            scrollEventThrottle={16}
            contentContainerStyle={{
              paddingBottom:
                Platform.OS === "ios"
                  ? Math.max(insets.bottom, 24) + 96 + iosBottomToolbarClearance
                  : Math.max(insets.bottom, 16) +
                    (Platform.OS === "android" ? HOME_COMPOSER_CLEARANCE * scale : 88),
            }}
          />
        </SwipeableScrollGateProvider>
      </View>
    </View>
  );
}
