import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";
import { useCallback } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface ProjectGroupLookUpdate {
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly projectColor?: ProjectIconColor | null;
}

/**
 * Saves a project folder's look (icon, colour) on every checkout of the group, like a Project
 * settings edit. Used from the sidebar and app rail menus; failures toast under `failureTitle`.
 */
export function useUpdateProjectGroup() {
  const { environments } = useEnvironments();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  return useCallback(
    (
      group: Pick<SidebarProjectSnapshot, "memberProjects">,
      input: ProjectGroupLookUpdate,
      failureTitle: string,
    ) => {
      const showError = (description: string) =>
        toastManager.add(stackedThreadToast({ type: "error", title: failureTitle, description }));
      // Check every checkout first so an offline one can't leave the group half-updated.
      const unavailable = group.memberProjects.find((member) => {
        const environment = environments.find((env) => env.environmentId === member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        showError(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        return;
      }
      void (async () => {
        for (const member of group.memberProjects) {
          const result = await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            showError(error instanceof Error ? error.message : "An error occurred.");
            return;
          }
        }
      })();
    },
    [environments, updateProject],
  );
}
