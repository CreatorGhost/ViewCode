import { useNavigation, useRoute, StackActions } from "@react-navigation/native";
import { nativePullRequestDestination } from "../lib/pullRequestNavigation";
import { useCallback } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useThreadShell } from "../state/entities";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";

type PullRequestContext = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId?: string;
};

// Navigator layouts have no route context, so list badges pass their source thread explicitly.
export function useNavigateToPullRequest(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  const replace = options?.replace;
  return useCallback(
    async (url: string, context: PullRequestContext | null) => {
      const destination = nativePullRequestDestination(url, context);
      if (!destination) return tryOpenExternalUrl(url, "pull-request");
      // Agent reviews run as the chat the pull request was opened from.
      const params = context?.threadId
        ? { ...destination, threadId: context.threadId }
        : destination;
      if (replace) navigation.dispatch(StackActions.replace("PullRequest", params));
      else navigation.navigate("PullRequest", params);
      return true;
    },
    [navigation, replace],
  );
}

export function useOpenPullRequest(options?: {
  readonly replace?: boolean;
  readonly context?: PullRequestContext;
}) {
  const route = useRoute();
  const routeContext = route.params as
    | {
        environmentId?: string | string[];
        projectId?: string | string[];
        threadId?: string | string[];
      }
    | undefined;
  const first = (value: string | string[] | undefined) => {
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ? text : undefined;
  };
  const environmentId = options?.context?.environmentId ?? first(routeContext?.environmentId);
  const threadId = options?.context?.threadId ?? first(routeContext?.threadId);
  const thread = useThreadShell(
    environmentId && threadId
      ? { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  const projectId =
    options?.context?.projectId ?? first(routeContext?.projectId) ?? thread?.projectId;
  const navigateToPullRequest = useNavigateToPullRequest({ replace: options?.replace });
  return useCallback(
    (url: string) =>
      navigateToPullRequest(
        url,
        environmentId && projectId
          ? {
              environmentId: String(environmentId),
              projectId: String(projectId),
              ...(threadId ? { threadId } : {}),
            }
          : null,
      ),
    [environmentId, projectId, threadId, navigateToPullRequest],
  );
}
