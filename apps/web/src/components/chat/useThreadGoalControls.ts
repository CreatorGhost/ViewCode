import type { EnvironmentId, ThreadGoal, ThreadId } from "@t3tools/contracts";
import { threadGoalUpdate, type GoalCommandAction } from "@t3tools/client-runtime/threadGoal";
import { useCallback, useMemo } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";
import {
  closeThreadGoalEditor,
  openThreadGoalEditor,
  useThreadGoalEditorStore,
  useUpdateThreadGoalState,
} from "./threadGoal";

/**
 * The goal and debug mode of the open chat, and the ways to change them. A started thread keeps
 * them on the server; a draft keeps them in its draft session until the first send carries them.
 */
export function useThreadGoalControls(input: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly isServerThread: boolean;
  readonly serverGoal: ThreadGoal | null | undefined;
  readonly serverDebugMode: boolean | undefined;
  readonly draftTarget: ComposerThreadTarget | null;
  readonly draftGoal: string | undefined;
  readonly draftDebugMode: boolean | undefined;
}) {
  const {
    threadKey,
    environmentId,
    threadId,
    isServerThread,
    serverGoal,
    serverDebugMode,
    draftTarget,
    draftGoal,
    draftDebugMode,
  } = input;
  const updateServer = useUpdateThreadGoalState();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const goal = useMemo<ThreadGoal | null>(
    () =>
      isServerThread
        ? (serverGoal ?? null)
        : draftGoal
          ? { objective: draftGoal, pausedAt: null, updatedAt: "" }
          : null,
    [draftGoal, isServerThread, serverGoal],
  );
  const debugMode = isServerThread ? serverDebugMode === true : draftDebugMode === true;
  const editorOpen = useThreadGoalEditorStore((state) => state.threadKey === threadKey);

  const change = useCallback(
    (fields: {
      readonly goal?: string | null;
      readonly goalPaused?: boolean;
      readonly debugMode?: boolean;
    }) => {
      if (isServerThread) {
        if (environmentId !== null && threadId !== null) {
          updateServer(environmentId, threadId, fields);
        }
        return;
      }
      if (draftTarget === null) return;
      setDraftThreadContext(draftTarget, {
        ...(fields.goal !== undefined ? { goal: fields.goal } : {}),
        ...(fields.debugMode !== undefined ? { debugMode: fields.debugMode } : {}),
      });
    },
    [draftTarget, environmentId, isServerThread, setDraftThreadContext, threadId, updateServer],
  );

  const setDebugMode = useCallback(
    (next: boolean) => {
      if (next !== debugMode) change({ debugMode: next });
    },
    [change, debugMode],
  );

  const applyGoalAction = useCallback(
    (action: GoalCommandAction) => {
      if (action.action === "edit") {
        openThreadGoalEditor(threadKey);
        return;
      }
      if (action.action === "too-long") {
        toastManager.add({ type: "warning", title: "That goal is too long" });
        return;
      }
      if ((action.action === "pause" || action.action === "resume") && goal === null) {
        toastManager.add({ type: "info", title: "This thread has no goal yet" });
        return;
      }
      if ((action.action === "pause" || action.action === "resume") && !isServerThread) {
        toastManager.add({
          type: "info",
          title: "A goal can be paused once the thread has started",
        });
        return;
      }
      const update = threadGoalUpdate(action);
      if (update !== null) change(update);
    },
    [change, goal, isServerThread, threadKey],
  );

  return {
    goal,
    debugMode,
    setDebugMode,
    applyGoalAction,
    editorOpen,
    openEditor: useCallback(() => openThreadGoalEditor(threadKey), [threadKey]),
    closeEditor: closeThreadGoalEditor,
    saveGoal: useCallback((objective: string) => change({ goal: objective }), [change]),
    setGoalPaused: useCallback((paused: boolean) => change({ goalPaused: paused }), [change]),
    clearGoal: useCallback(() => change({ goal: null }), [change]),
  };
}
