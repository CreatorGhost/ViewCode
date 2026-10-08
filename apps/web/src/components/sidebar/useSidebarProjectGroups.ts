import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "../Sidebar.logic";

/**
 * The sidebar's project folders, grouped across environments and in sidebar order. The app
 * rail's project switcher reads the same list so both offer the same projects in the same order.
 */
export function useSidebarProjectGroups(): ReadonlyArray<SidebarProjectSnapshot> {
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const unsortedGroups = useMemo(() => {
    const labelById = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    return buildSidebarProjectSnapshots({
      projects:
        sortOrder === "manual"
          ? orderItemsByPreferredIds({
              items: projects,
              preferredIds: projectOrder,
              getId: getProjectOrderKey,
              getPreferenceIds: (project) => [
                getProjectOrderKey(project),
                legacyProjectCwdPreferenceKey(project.workspaceRoot),
              ],
            })
          : projects,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labelById.get(environmentId) ?? null,
    });
  }, [environments, groupingSettings, primaryEnvironmentId, projectOrder, projects, sortOrder]);
  return useMemo(
    () => sortLogicalProjectsForSidebar(unsortedGroups, threads, sortOrder),
    [sortOrder, threads, unsortedGroups],
  );
}
