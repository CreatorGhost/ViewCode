import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "./home-route-visibility";
import { useHomeThreadSelection } from "./home-thread-navigation";
import {
  buildHomeTerminalTargets,
  findSelectedTerminalTarget,
  type HomeTerminalTarget,
} from "./homeTerminalTargets";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { HomeScopeFilters } from "./HomeScopeFilters";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { useOpenRockBot } from "./useOpenRockBot";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout, panes } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  // Streaming turns rewrite thread shells many times a second. While a Thread
  // covers Home, rebuilding this list is invisible work.
  const visible = useHomeRouteVisible();
  const threads = useAtomValueWhileVisible(environmentThreadShells.threadShellsAtom, visible);
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");
  const handleSelectThread = useHomeThreadSelection();

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options: listOptions, setSelectedEnvironmentId } =
    useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  // Same order as Home's folders, so the menu reads like the list under it.
  const projectFilterOptions = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects,
          environmentId: selectedEnvironmentId,
          projectGroupingMode: listOptions.projectGroupingMode,
        }),
        threads,
        pendingTasks,
        projectSortOrder: listOptions.projectSortOrder,
      }).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [
      listOptions.projectGroupingMode,
      listOptions.projectSortOrder,
      pendingTasks,
      projects,
      selectedEnvironmentId,
      threads,
    ],
  );
  // Home's terminal button (Android's bottom bar, iOS's header) opens through a project's latest thread.
  const terminalTargets = useMemo(
    () =>
      buildHomeTerminalTargets({
        scopes: buildHomeProjectScopes({
          projects,
          environmentId: selectedEnvironmentId,
          projectGroupingMode: listOptions.projectGroupingMode,
        }),
        threads,
      }),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId, threads],
  );
  const selectedTerminalTarget = useMemo(
    () => findSelectedTerminalTarget(terminalTargets, selectedProjectKey),
    [selectedProjectKey, terminalTargets],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);

  const openRockBot = useOpenRockBot(
    selectedEnvironmentId ?? environments[0]?.environmentId ?? null,
  );

  const openTerminal = (target: HomeTerminalTarget) =>
    navigation.navigate("ThreadTerminal", {
      environmentId: String(target.environmentId),
      threadId: String(target.threadId),
    });

  const homeHeaderProps: HomeHeaderProps = {
    environments,
    projects: projectFilterOptions,
    searchQuery,
    selectedEnvironmentId,
    selectedProjectKey,
    onEnvironmentChange: setSelectedEnvironmentId,
    onProjectChange: setSelectedProjectKey,
    onOpenEnvironments: () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsEnvironments" },
      }),
    onOpenSettings: () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "Settings" },
      }),
    onOpenUsage: () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsUsage" },
      }),
    ...(openRockBot === undefined ? {} : { onOpenRockBot: openRockBot }),
    onSearchQueryChange: setSearchQuery,
    onStartNewTask: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
    onOpenPullRequests: () => navigation.navigate("PullRequests"),
    terminalTargets,
    selectedTerminalTarget,
    onOpenTerminal: openTerminal,
  };

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : { title: "", headerTitle: "", unstable_headerLeftItems: () => [] }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New task"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Threads" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew" },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTask" })
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      terminalTargets={terminalTargets}
      selectedTerminalTarget={selectedTerminalTarget}
      onOpenTerminal={openTerminal}
    >
      <>
        <HomeHeader {...homeHeaderProps} />

        <HomeScreen
          listHeaderContent={
            Platform.OS === "ios" ? <HomeScopeFilters {...homeHeaderProps} /> : undefined
          }
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironmentNew" },
            })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onSetThreadAutoSettle={setThreadAutoSettle}
          onMoveThread={moveThread}
          onRenameThread={renameThread}
          onRegenerateThreadTitle={regenerateThreadTitle}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onSearchQueryChange={setSearchQuery}
          onSelectThread={handleSelectThread}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadOnBranch={(thread) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(thread.environmentId),
                projectId: String(thread.projectId),
                branch: thread.branch,
                worktreePath: thread.worktreePath,
              },
            });
          }}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={selectedProjectKey}
          threads={threads}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
