import type { OrchestrationThreadShell } from "@t3tools/client-runtime/viewcodeThread";

import type { EnvironmentId } from "@t3tools/contracts";
import {
  isThreadGoalPaused,
  parseGoalCommandArgs,
  threadGoalUpdate,
  type GoalCommandAction,
} from "@t3tools/client-runtime/threadGoal";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { useCallback } from "react";
import { Alert, Platform, type AlertButton } from "react-native";

import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The thread's goal and debug mode as the mobile composer changes them: the `/goal`, `/debug` and
 * `/default` commands and the toolbar's Goal and Debug controls. Same rules as web
 * (client-runtime `threadGoal.ts`).
 */
export function useThreadGoalActions(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
  readonly onUpdateInteractionMode?: (mode: "default") => void;
}) {
  const { environmentId, thread, onUpdateInteractionMode } = input;
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const goal = thread.goal ?? null;
  const debugMode = thread.debugMode === true;

  const change = useCallback(
    (fields: {
      readonly goal?: string | null;
      readonly goalPaused?: boolean;
      readonly debugMode?: boolean;
    }) => {
      const now = DateTime.formatIso(DateTime.nowUnsafe());
      const nextGoal =
        fields.goal === undefined
          ? goal
          : fields.goal === null
            ? null
            : { objective: fields.goal, pausedAt: null, updatedAt: now };
      const viewcodeGoal =
        fields.goalPaused === undefined || nextGoal === null
          ? nextGoal
          : { ...nextGoal, pausedAt: fields.goalPaused ? now : null, updatedAt: now };
      void updateThreadMetadata({
        environmentId,
        input: {
          threadId: thread.id,
          ...(fields.goal !== undefined || fields.goalPaused !== undefined ? { viewcodeGoal } : {}),
          ...(fields.debugMode === undefined ? {} : { debugMode: fields.debugMode }),
        },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Alert.alert(
          fields.debugMode === undefined
            ? "Could not update the goal"
            : "Could not change debug mode",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Try again in a moment.",
        );
      });
    },
    [environmentId, thread.id, updateThreadMetadata, goal],
  );

  const editGoal = useCallback(() => {
    const save = (value: string) => {
      const action = parseGoalCommandArgs(`-- ${value}`);
      if (action.action === "too-long") {
        Alert.alert("That goal is too long");
        return;
      }
      if (action.action === "set" && action.objective !== goal?.objective) {
        change({ goal: action.objective });
      }
    };
    if (Platform.OS === "ios") {
      Alert.prompt(
        "Thread goal",
        undefined,
        (value) => save(value ?? ""),
        "plain-text",
        goal?.objective,
      );
      return;
    }
    showTextInputDialog({
      title: "Thread goal",
      initialValue: goal?.objective ?? "",
      confirmText: "Save",
      onConfirm: save,
    });
  }, [change, goal?.objective]);

  /** The Goal control and a bare `/goal`: edit, pause or resume, clear. */
  const openGoalActions = useCallback(() => {
    if (goal === null) {
      editGoal();
      return;
    }
    const paused = isThreadGoalPaused(goal);
    const buttons: AlertButton[] = [
      { text: "Edit", onPress: editGoal },
      { text: paused ? "Resume" : "Pause", onPress: () => change({ goalPaused: !paused }) },
      { text: "Clear", style: "destructive", onPress: () => change({ goal: null }) },
    ];
    // Android shows at most three buttons; the dialog is dismissed by tapping outside.
    if (Platform.OS === "ios") buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(paused ? "Goal (paused)" : "Goal", goal.objective, buttons, { cancelable: true });
  }, [change, editGoal, goal]);

  const applyGoalAction = useCallback(
    (action: GoalCommandAction) => {
      if (action.action === "edit") {
        openGoalActions();
        return;
      }
      if (action.action === "too-long") {
        Alert.alert("That goal is too long");
        return;
      }
      if ((action.action === "pause" || action.action === "resume") && goal === null) {
        Alert.alert("This thread has no goal yet");
        return;
      }
      const update = threadGoalUpdate(action);
      if (update !== null) change(update);
    },
    [change, goal, openGoalActions],
  );

  /** `/debug` turns debug mode on; `/default` leaves both plan and debug mode. */
  const applyThreadCommand = useCallback(
    (command: "debug" | "default") => {
      if (command === "default") onUpdateInteractionMode?.("default");
      const next = command === "debug";
      if (next !== debugMode) change({ debugMode: next });
    },
    [change, debugMode, onUpdateInteractionMode],
  );

  const confirmLeaveDebugMode = useCallback(() => {
    Alert.alert(
      "Debug mode",
      "The agent reproduces the problem and gathers evidence before fixing it.",
      [
        { text: "Keep on", style: "cancel" },
        { text: "Leave debug mode", onPress: () => change({ debugMode: false }) },
      ],
    );
  }, [change]);

  return {
    goal,
    debugMode,
    applyGoalAction,
    applyThreadCommand,
    openGoalActions,
    confirmLeaveDebugMode,
  };
}
