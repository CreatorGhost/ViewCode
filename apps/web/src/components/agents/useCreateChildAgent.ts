import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Resolves once the thread's shell reaches the client store (false on timeout). */
function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 5_000): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(atom) !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(atom, (shell) => {
      if (shell === null) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    });
  });
}

/**
 * Creates an empty child agent of `parent`: a new thread in the same project
 * and workspace with the parent's model and modes, then opens it so the user
 * can write its first message.
 */
export function useCreateChildAgent() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (parent: EnvironmentThreadShell) => {
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: parent.environmentId,
        input: {
          threadId,
          projectId: parent.projectId,
          title: "New agent",
          modelSelection: parent.modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          branch: parent.branch,
          worktreePath: parent.worktreePath,
          parentThreadId: parent.id,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create agent",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      await waitForThreadShell(scopeThreadRef(parent.environmentId, threadId));
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: parent.environmentId, threadId },
      });
    },
    [createThread, navigate],
  );
}
