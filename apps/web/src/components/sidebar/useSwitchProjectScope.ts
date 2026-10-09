import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { readThreadShell, readThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadTabsStore } from "../../threadTabsStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { pickProjectSwitchThread, projectRefKey } from "./projectSwitch.logic";

/**
 * Switches the sidebar to one project folder (or All, with null) and shows that folder's work:
 * the thread already open stays when it belongs there, else the folder's latest thread opens,
 * else a new thread in it. Picking the scoped folder again never returns to All.
 */
export function useSwitchProjectScope() {
  const navigate = useNavigate();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (project: SidebarProjectSnapshot | null) => {
      useUiStateStore.getState().setSidebarProjectScopeKey(project?.projectKey ?? null);
      if (!project) return;
      const memberProjectKeys = new Set(project.memberProjectRefs.map(projectRefKey));
      const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const current =
        route?.kind === "server"
          ? readThreadShell(route.threadRef)
          : route?.kind === "draft"
            ? useComposerDraftStore.getState().getDraftSession(route.draftId)
            : null;
      if (current && memberProjectKeys.has(projectRefKey(current))) return;
      const { recentThreadKeys, tabsByEnvironmentId } = useThreadTabsStore.getState();
      const target = pickProjectSwitchThread({
        memberProjectKeys,
        threads: readThreadShells(),
        recentThreadKeys,
        openTabKeys: Object.values(tabsByEnvironmentId).flat(),
      });
      if (target) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: target.environmentId, threadId: target.id },
        });
        return;
      }
      // Like New thread in a folder: the member on this machine when the folder spans several.
      const projectRef =
        project.memberProjectRefs.find((ref) => ref.environmentId === primaryEnvironmentId) ??
        project.memberProjectRefs[0];
      if (projectRef) void handleNewThread(projectRef);
    },
    [handleNewThread, navigate, primaryEnvironmentId, router],
  );
}
