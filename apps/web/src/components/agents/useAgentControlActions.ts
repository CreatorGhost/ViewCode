import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentControlScope, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { agentControlEnvironment } from "../../state/agentControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

function reportFailure<A, E>(result: AtomCommandResult<A, E>, title: string): boolean {
  if (result._tag !== "Failure") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
  return false;
}

/**
 * Stop, resume and discard for ViewCode agents. `tree` acts on the whole
 * agent tree the thread belongs to. Resolves true when the server applied it.
 */
export function useAgentControlActions() {
  const stop = useAtomCommand(agentControlEnvironment.stop, { reportFailure: false });
  const resume = useAtomCommand(agentControlEnvironment.resume, { reportFailure: false });
  const discard = useAtomCommand(agentControlEnvironment.discard, { reportFailure: false });

  return {
    stop: useCallback(
      async (ref: ScopedThreadRef, scope: AgentControlScope) =>
        reportFailure(
          await stop({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, scope },
          }),
          "Could not stop the agents",
        ),
      [stop],
    ),
    resume: useCallback(
      async (ref: ScopedThreadRef, scope: AgentControlScope) =>
        reportFailure(
          await resume({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, scope },
          }),
          "Could not resume",
        ),
      [resume],
    ),
    discard: useCallback(
      async (ref: ScopedThreadRef, scope: AgentControlScope) =>
        reportFailure(
          await discard({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, scope },
          }),
          "Could not discard the held messages",
        ),
      [discard],
    ),
  };
}
