import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { Menu } from "../../components/ui/Menu";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  beginQueuedRunEdit,
  getQueuedRunEdit,
  useQueuedRunEdit,
} from "../../state/queued-run-edit";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { environmentScopeAtom } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildCancelQueuedRunCommand,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

type QueueAction = "edit" | "up" | "down" | "remove";

/** Accepted messages come from the server projection, including other devices' edits. */
export function ViewCodeThreadQueue({ target }: { readonly target: ScopedThreadRef }) {
  const workflow = useAtomValue(environmentThreadDetails.queueWorkflowAtom(target));
  const permission = environmentScopeAtom(target.environmentId, AuthOrchestrationOperateScope);
  const canOperate = useAtomValue(permission);
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const queuedRuns = workflow?.queuedRuns ?? [];

  const perform = async (runId: RunId | null, action: QueueAction | "resume") => {
    if (inFlight.current || !appAtomRegistry.get(permission)) return;
    // A remote client can consume or remove a row between rendering and pressing it.
    const current = appAtomRegistry.get(environmentThreadDetails.queueWorkflowAtom(target));
    const rows = current?.queuedRuns ?? [];
    const index = rows.findIndex(({ run }) => run.id === runId);
    const entry = rows[index];
    if (action === "resume" ? !current?.isHeld : entry === undefined) return;
    if (action === "edit" && entry) {
      if (getQueuedRunEdit(threadKey)?.runId === entry.run.id) return;
      beginQueuedRunEdit(threadKey, {
        runId: entry.run.id,
        messageId: entry.messageId,
        originalText: entry.text,
        existingAttachments: entry.attachments,
        ...(entry.context === undefined ? {} : { context: entry.context }),
      });
      return;
    }
    if ((action === "up" || action === "down") && !current?.canReorder) return;
    if (action === "up" && index === 0) return;
    if (action === "down" && index === rows.length - 1) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (action === "resume") {
        await resume({ ...target, input: { threadId: target.threadId } });
      } else if (entry && action === "remove") {
        await cancel(buildCancelQueuedRunCommand({ ...target, runId: entry.run.id }));
      } else if (entry && (action === "up" || action === "down")) {
        await reorder({
          ...target,
          input: {
            threadId: target.threadId,
            runId: entry.run.id,
            beforeRunId:
              action === "up" ? rows[index - 1]!.run.id : (rows[index + 2]?.run.id ?? null),
          },
        });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (queuedRuns.length === 0) return null;
  return (
    <View className="mx-4 mb-2 overflow-hidden rounded-2xl border border-border bg-card">
      <View className="flex-row items-center px-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Hide" : "Show"} shared queue`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          className="min-h-11 flex-1 justify-center"
        >
          <Text className="font-t3-medium text-xs text-foreground">
            {queuedRuns.length} queued{workflow?.isHeld ? " · Held" : ""}
          </Text>
        </Pressable>
        {workflow?.isHeld ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume shared queue"
            disabled={busy || !canOperate}
            onPress={() => void perform(null, "resume")}
            className="min-h-11 justify-center pl-3 disabled:opacity-40"
          >
            <Text className="font-t3-medium text-xs text-primary">Resume</Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 184 }}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          {queuedRuns.map((entry, index) => {
            const controls = resolveThreadQueueRowControls({
              busy: busy || !canOperate,
              canPromoteToSteer: false,
              canReorder: workflow?.canReorder ?? false,
              index,
              isEditing: editing?.runId === entry.run.id,
              queuedCount: queuedRuns.length,
              text: entry.text,
            });
            return (
              <View
                key={entry.run.id}
                className="flex-row items-center gap-2 border-t border-border px-3"
              >
                <View className="min-w-0 flex-1 py-2">
                  <Text className="text-xs text-foreground" numberOfLines={2}>
                    {entry.text ||
                      (entry.attachments.length > 0 ? "Attachments" : "Queued message")}
                  </Text>
                  {entry.attachments.length > 0 ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {entry.attachments.map((attachment) => attachment.name).join(", ")}
                    </Text>
                  ) : null}
                  {controls.isEditing ? (
                    <Text className="text-xs text-primary">Editing</Text>
                  ) : null}
                </View>
                <Menu
                  accessibilityLabel={`Actions for queued message ${index + 1}`}
                  actions={[
                    { id: "edit", title: "Edit", attributes: { disabled: !controls.canEdit } },
                    { id: "up", title: "Move up", attributes: { disabled: !controls.canMoveUp } },
                    {
                      id: "down",
                      title: "Move down",
                      attributes: { disabled: !controls.canMoveDown },
                    },
                    {
                      id: "remove",
                      title: "Cancel message",
                      attributes: { disabled: !controls.canDismiss, destructive: true },
                    },
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    const action = nativeEvent.event;
                    if (
                      action === "edit" ||
                      action === "up" ||
                      action === "down" ||
                      action === "remove"
                    ) {
                      void perform(entry.run.id, action);
                    }
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for queued message ${index + 1}`}
                    className="min-h-11 min-w-11 items-center justify-center"
                  >
                    <Text className="text-lg text-foreground">⋯</Text>
                  </Pressable>
                </Menu>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
