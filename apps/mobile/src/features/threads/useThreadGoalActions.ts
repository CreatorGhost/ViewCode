import type { OrchestrationThreadShell } from "@t3tools/client-runtime/viewcodeThread";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  isThreadGoalPaused,
  parseGoalCommandArgs,
  threadGoalRunMessage,
  threadGoalRunState,
  threadGoalUpdate,
  type GoalCommandAction,
} from "@t3tools/client-runtime/threadGoal";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { useCallback } from "react";
import { Alert, Platform, type AlertButton } from "react-native";

import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
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
  /** What Run goal sends with: the composer's current model and modes, and whether it can send. */
  readonly run: {
    readonly working: boolean;
    readonly canSend: boolean;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
}) {
  const { environmentId, thread, onUpdateInteractionMode, run } = input;
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

  const runState = threadGoalRunState({ goal, working: run.working, canSend: run.canSend });
  // The same visible message as web's Run goal, through the outbox like any composer send. It
  // leaves the user's draft alone.
  const runGoal = useCallback(() => {
    const metadata = makeQueuedMessageMetadata();
    enqueueThreadOutboxMessage({
      environmentId,
      threadId: thread.id,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: threadGoalRunMessage({ hasMessages: thread.latestTurn !== null, goalChanged: false }),
      attachments: [],
      modelSelection: run.modelSelection,
      runtimeMode: run.runtimeMode,
      interactionMode: run.interactionMode,
      createdAt: metadata.createdAt,
    }).catch((error: unknown) => {
      Alert.alert(
        "Could not run the goal",
        error instanceof Error ? error.message : "The message could not be queued.",
      );
    });
  }, [
    environmentId,
    thread.id,
    thread.latestTurn,
    run.modelSelection,
    run.runtimeMode,
    run.interactionMode,
  ]);

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
    const title = paused ? "Goal (paused)" : "Goal";
    const pauseButton: AlertButton = {
      text: paused ? "Resume" : "Pause",
      onPress: () => change({ goalPaused: !paused }),
    };
    const clearButton: AlertButton = {
      text: "Clear",
      style: "destructive",
      onPress: () => change({ goal: null }),
    };
    const runButton: AlertButton | null =
      runState === "ready" ? { text: "Run", onPress: runGoal } : null;
    // Android shows at most three buttons; the dialog is dismissed by tapping outside.
    const buttons: AlertButton[] =
      Platform.OS === "ios"
        ? [
            ...(runButton ? [runButton] : []),
            { text: "Edit", onPress: editGoal },
            pauseButton,
            clearButton,
            { text: "Cancel", style: "cancel" },
          ]
        : runButton
          ? [
              runButton,
              { text: "Edit", onPress: editGoal },
              {
                text: "More",
                onPress: () =>
                  Alert.alert(title, goal.objective, [pauseButton, clearButton], {
                    cancelable: true,
                  }),
              },
            ]
          : [{ text: "Edit", onPress: editGoal }, pauseButton, clearButton];
    Alert.alert(title, goal.objective, buttons, { cancelable: true });
  }, [change, editGoal, goal, runGoal, runState]);

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
      if (
        (action.action === "run" || action.action === "pause" || action.action === "resume") &&
        goal === null
      ) {
        Alert.alert("This thread has no goal yet");
        return;
      }
      if (action.action === "run") {
        if (runState === "ready") runGoal();
        else
          Alert.alert(
            runState === "paused"
              ? "The goal is paused"
              : runState === "working"
                ? "Run the goal when the current turn ends"
                : "Can't run the goal right now",
          );
        return;
      }
      const update = threadGoalUpdate(action);
      if (update !== null) change(update);
    },
    [change, goal, openGoalActions, runGoal, runState],
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
