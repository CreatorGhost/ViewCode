import { useNavigate, useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useOpenPullRequests } from "../pullRequest/useOpenPullRequests";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { readThreadShell, readThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadTabsStore } from "../../threadTabsStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { pickProjectSwitchThread, projectRefKey } from "./projectSwitch.logic";
import { isRockBot } from "@t3tools/client-runtime/state/rockbot";

/**
 * Switches the sidebar to one project folder (or All, with null) and shows that folder's work:
 * the thread already open stays when it belongs there, else the folder's latest thread opens,
 * else a new thread in it. Picking the scoped folder again never returns to All. On the Pull
 * Requests page the list follows the folder instead, and the page stays open. From a RockBot
 * chat, which sits outside every folder, any pick (All included) leaves for the user's work.
 */
export function useSwitchProjectScope() {
  const navigate = useNavigate();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openPullRequests = useOpenPullRequests();
  return (project: SidebarProjectSnapshot | null) => {
    useUiStateStore.getState().setSidebarProjectScopeKey(project?.projectKey ?? null);
    if (router.state.location.pathname === "/pull-requests") {
      void openPullRequests();
      return;
    }
    const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const current =
      route?.kind === "server"
        ? readThreadShell(route.threadRef)
        : route?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(route.draftId)
          : null;
    const onRockBot = current !== null && "source" in current && isRockBot(current.source);
    if (!project && !onRockBot) return;
    const memberProjectKeys = project
      ? new Set(project.memberProjectRefs.map(projectRefKey))
      : null;
    if (
      current &&
      !onRockBot &&
      memberProjectKeys !== null &&
      memberProjectKeys.has(projectRefKey(current))
    )
      return;
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
    if (!project) return;
    // Like New thread in a folder: the member on this machine when the folder spans several.
    const projectRef =
      project.memberProjectRefs.find((ref) => ref.environmentId === primaryEnvironmentId) ??
      project.memberProjectRefs[0];
    if (projectRef) void handleNewThread(projectRef);
  };
}
