import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { useCallback } from "react";

import { newThreadId } from "~/lib/utils";
import { readThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { forkThreadTitle } from "./forkThread.logic";
import { waitForThreadShell } from "./useCreateChildAgent";

/**
 * Forks `source` at `messageId`: a new thread in the same project with the same
 * model and workspace. The server copies the history up to that message.
 */
export function useForkThreadFromMessage() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (source: ScopedThreadRef, messageId: MessageId) => {
      const shell = readThreadShell(source);
      if (shell === null) return;
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: source.environmentId,
        input: {
          threadId,
          projectId: shell.projectId,
          title: forkThreadTitle(shell.title),
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          branch: shell.branch,
          worktreePath: shell.worktreePath,
          forkFrom: { threadId: source.threadId, messageId },
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not fork thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      await waitForThreadShell(scopeThreadRef(source.environmentId, threadId));
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: source.environmentId, threadId },
      });
    },
    [createThread, navigate],
  );
}

export function ForkFromMessageButton({
  threadRef,
  messageId,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
}) {
  const fork = useForkThreadFromMessage();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Fork from here"
            size="xs"
            variant="ghost"
            onClick={() => void fork(threadRef, messageId)}
          >
            <GitForkIcon />
          </Button>
        }
      />
      <TooltipPopup>Fork from here</TooltipPopup>
    </Tooltip>
  );
}
