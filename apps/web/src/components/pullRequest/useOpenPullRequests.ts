import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { useSidebarProjectSnapshots } from "../sidebar/useSidebarProjectGroups";
import {
  pullRequestListPreferencesForFolder,
  readPullRequestListPreferences,
} from "./pullRequestListPreferences";

/**
 * Opens the Pull Requests page with the reader's remembered controls, scoped to the project
 * folder the sidebar and rail have selected, or to every project under All. The page's own
 * project filter carries the scope, so it can still be widened there.
 */
export function useOpenPullRequests() {
  const navigate = useNavigate();
  const folders = useSidebarProjectSnapshots();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(() => {
    const scopeKey = useUiStateStore.getState().sidebarProjectScopeKey;
    // A scope whose folder is gone reads as All, as it does in the rail.
    const folder =
      scopeKey === null ? undefined : folders.find((entry) => entry.projectKey === scopeKey);
    return navigate({
      to: "/pull-requests",
      search: pullRequestListPreferencesForFolder(
        readPullRequestListPreferences(),
        folder?.memberProjectRefs ?? null,
        primaryEnvironmentId,
      ),
    });
  }, [folders, navigate, primaryEnvironmentId]);
}
