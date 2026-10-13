import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import { create } from "zustand";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Which thread's goal editor is open. The header chip, `/goal` and the command palette open it;
 * the chat view of that thread renders it.
 */
export const useThreadGoalEditorStore = create<{ readonly threadKey: string | null }>(() => ({
  threadKey: null,
}));

export function openThreadGoalEditor(threadKey: string): void {
  useThreadGoalEditorStore.setState({ threadKey });
}

export function closeThreadGoalEditor(): void {
  useThreadGoalEditorStore.setState({ threadKey: null });
}

export interface ThreadGoalStateChange {
  readonly goal?: string | null;
  readonly goalPaused?: boolean;
  readonly debugMode?: boolean;
}

/** Saves a started thread's goal or debug mode, with a toast when the server refuses. */
export function useUpdateThreadGoalState() {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId, change: ThreadGoalStateChange) => {
      void updateMetadata({ environmentId, input: { threadId, ...change } }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title:
              change.debugMode === undefined
                ? "Couldn't update the goal"
                : "Couldn't change debug mode",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [updateMetadata],
  );
}
