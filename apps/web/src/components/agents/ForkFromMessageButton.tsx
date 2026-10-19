import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { useState } from "react";

import { newThreadId, randomUUID } from "~/lib/utils";
import { readThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentScope } from "../../state/session";
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
  const createThread = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });

  return async (source: ScopedThreadRef, messageId: MessageId) => {
    const shell = readThreadShell(source);
    if (shell === null) return;
    const threadId = newThreadId();
    const result = await createThread({
      environmentId: source.environmentId,
      input: {
        type: "thread.fork",
        commandId: CommandId.make(randomUUID()),
        sourceThreadId: source.threadId,
        targetThreadId: threadId,
        sourcePoint: { type: "latest_stable" },
        sourceMessageId: messageId,
        title: forkThreadTitle(shell.title),
        createdBy: "user",
        creationSource: "web",
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
  };
}

export function ForkFromMessageButton({
  threadRef,
  messageId,
  disabled = false,
}: {
  threadRef: ScopedThreadRef;
  messageId: MessageId;
  disabled?: boolean;
}) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const [busy, setBusy] = useState(false);
  const fork = useForkThreadFromMessage();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Fork from here"
            size="xs"
            variant="ghost"
            disabled={disabled || busy || !canOperate}
            onClick={() => {
              setBusy(true);
              void fork(threadRef, messageId).finally(() => setBusy(false));
            }}
          >
            <GitForkIcon />
          </Button>
        }
      />
      <TooltipPopup>Fork from here</TooltipPopup>
    </Tooltip>
  );
}
