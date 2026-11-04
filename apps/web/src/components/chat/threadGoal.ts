import { readThreadShell } from "../../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Which thread's goal editor is open, and which thread was asked to run its goal. The header chip,
 * `/goal` and the command palette ask; the chat view of that thread owns the dialog and the send.
 */
export const useThreadGoalEditorStore = create<{
  readonly threadKey: string | null;
  readonly runThreadKey: string | null;
}>(() => ({
  threadKey: null,
  runThreadKey: null,
}));

export function openThreadGoalEditor(threadKey: string): void {
  useThreadGoalEditorStore.setState({ threadKey });
}

export function closeThreadGoalEditor(): void {
  useThreadGoalEditorStore.setState({ threadKey: null });
}

export function requestThreadGoalRun(threadKey: string): void {
  useThreadGoalEditorStore.setState({ runThreadKey: threadKey });
}

export function clearThreadGoalRunRequest(): void {
  useThreadGoalEditorStore.setState({ runThreadKey: null });
}

export interface ThreadGoalStateChange {
  readonly goal?: string | null;
  readonly goalPaused?: boolean;
  readonly debugMode?: boolean;
}

/**
 * Saves a started thread's goal or debug mode, with a toast when the server refuses. Resolves
 * true once the server took it, so Save & run starts the turn only after the goal is stored.
 */
export function useUpdateThreadGoalState() {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return (environmentId: EnvironmentId, threadId: ThreadId, change: ThreadGoalStateChange) => {
    const current =
      readThreadShell(scopeThreadRef(environmentId, threadId))?.source.viewcodeGoal ?? null;
    const updatedAt = new Date().toISOString();
    const viewcodeGoal =
      change.goal !== undefined
        ? change.goal === null || change.goal.trim() === ""
          ? null
          : { objective: change.goal.trim(), pausedAt: null, updatedAt }
        : change.goalPaused !== undefined && current !== null
          ? { ...current, pausedAt: change.goalPaused ? updatedAt : null, updatedAt }
          : undefined;
    return updateMetadata({
      environmentId,
      input: {
        threadId,
        ...(viewcodeGoal === undefined ? {} : { viewcodeGoal }),
        ...(change.debugMode === undefined ? {} : { debugMode: change.debugMode }),
      },
    }).then((result) => {
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
      return result._tag === "Success";
    });
  };
}
