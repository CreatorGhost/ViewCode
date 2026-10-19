import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isViewCodePanelThreadPreparing } from "./ensureViewCodePanelThread";
import type { EnvironmentId, ThreadGoal, ThreadId } from "@t3tools/contracts";
import { threadGoalUpdate, type GoalCommandAction } from "@t3tools/client-runtime/threadGoal";

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
  const goal = (() =>
    isServerThread
      ? (serverGoal ?? null)
      : draftGoal
        ? { objective: draftGoal, pausedAt: null, updatedAt: "" }
        : null)();
  const debugMode = isServerThread ? serverDebugMode === true : draftDebugMode === true;
  const editorOpen = useThreadGoalEditorStore((state) => state.threadKey === threadKey);

  const change = (fields: {
    readonly goal?: string | null;
    readonly goalPaused?: boolean;
    readonly debugMode?: boolean;
  }) => {
    // Record-only panel creation captures these fields before its receipt.
    // Block edits across all callers until that handover finishes; a later
    // reconciliation could overwrite another client's newer server values.
    if (
      environmentId !== null &&
      threadId !== null &&
      isViewCodePanelThreadPreparing(scopeThreadRef(environmentId, threadId))
    ) {
      toastManager.add({
        type: "info",
        title: "Preparing thread",
        description: "Try changing the goal or debug mode again in a moment.",
      });
      return;
    }
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
  };

  const setDebugMode = (next: boolean) => {
    if (next !== debugMode) change({ debugMode: next });
  };

  const applyGoalAction = (action: GoalCommandAction) => {
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
  };

  return {
    goal,
    debugMode,
    setDebugMode,
    applyGoalAction,
    editorOpen,
    openEditor: () => openThreadGoalEditor(threadKey),
    closeEditor: closeThreadGoalEditor,
    saveGoal: (objective: string) => change({ goal: objective }),
    setGoalPaused: (paused: boolean) => change({ goalPaused: paused }),
    clearGoal: () => change({ goal: null }),
  };
}
