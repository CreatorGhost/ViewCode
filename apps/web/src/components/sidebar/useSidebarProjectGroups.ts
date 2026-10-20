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
import { holdsOnlyRockBot } from "@t3tools/client-runtime/state/rockbot";
import { useComposerDraftStore } from "../../composerDraftStore";
import { projectRefKey } from "./projectSwitch.logic";

/**
 * The sidebar's project folders with their names and members, not yet in sidebar order. For
 * readers that only need a folder's name or members: the order follows thread activity, and
 * subscribing to it would re-render them on every thread update.
 */
export function useSidebarProjectSnapshots(): ReadonlyArray<SidebarProjectSnapshot> {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return (() => {
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
  })();
}

/**
 * The sidebar's project folders, grouped across environments and in sidebar order. The app
 * rail's project switcher reads the same list so both offer the same projects in the same order.
 */
export function useSidebarProjectGroups(): ReadonlyArray<SidebarProjectSnapshot> {
  const unsortedGroups = useSidebarProjectSnapshots();
  const threads = useThreadShells();
  const sortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  // An unsent draft keeps its folder, so a new "No project" chat shows while it is typed.
  const draftProjectKeys = useComposerDraftStore((store) =>
    Object.values(store.draftThreadsByThreadKey)
      .flatMap((draft) => (draft.promotedTo == null ? [projectRefKey(draft)] : []))
      .toSorted()
      .join("\n"),
  );
  return (() => {
    const drafted = new Set(draftProjectKeys.split("\n"));
    // The scratch folder RockBot alone uses is RockBot's, reached from its rail button.
    const groups = unsortedGroups.filter((group) => {
      if (!group.isScratch) return true;
      const members = new Set(group.memberProjectRefs.map(projectRefKey));
      if ([...members].some((key) => drafted.has(key))) return true;
      return !holdsOnlyRockBot(members, threads, (thread) => thread.source.kind);
    });
    return sortLogicalProjectsForSidebar(groups, threads, sortOrder);
  })();
}
