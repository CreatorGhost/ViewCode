import type { EnvironmentThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";

import { Alert } from "react-native";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";

/** Called once per thread list so virtualized rows share one stable handler. */
export function useOpenThreadPullRequests() {
  const navigation = useNavigation();
  const navigateToPullRequest = useNavigateToPullRequest();
  return useCallback(
    (thread: EnvironmentThreadShell, pr: ThreadPrPresentation) => {
      if (resolveThreadPrBadgeAction(pr).kind === "list") {
        navigation.navigate("ThreadPullRequests", {
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        });
        return;
      }
      void navigateToPullRequest(pr.url, {
        environmentId: String(thread.environmentId),
        projectId: String(thread.projectId),
        threadId: String(thread.id),
      }).then((opened) => {
        if (!opened) Alert.alert("Unable to open PR", "The pull request could not be opened.");
      });
    },
    [navigation, navigateToPullRequest],
  );
}
