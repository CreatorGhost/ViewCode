import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { composerContextSendBlockReason } from "../lib/composerContext";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  endQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  useQueuedRunEdit,
} from "./queued-run-edit";
import { readEnvironmentScope } from "./session";
import { serverEnvironment } from "./server";
import { setThreadComposerError, clearThreadComposerError } from "./thread-composer-error";
import { environmentThreadDetails, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  composerContextImportsAtom,
  composerDraftsAtom,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachments,
  scheduleUnusedComposerAttachmentCleanup,
} from "./use-composer-drafts";

const CONSUMED_MESSAGE =
  "That queued message already started or was removed. Your edit is still here; cancel editing to return to your normal draft.";

export function activeComposerDraftKey(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
): string {
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const edit = getQueuedRunEdit(threadKey);
  return edit === null ? threadKey : queuedEditDraftKey(threadKey, edit.runId);
}

export function useQueuedRunEditComposer(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId"> | null,
  workflow: ThreadQueueWorkflowState | null,
) {
  const threadKey = thread ? scopedThreadKey(thread.environmentId, thread.id) : null;
  const queuedRunEdit = useQueuedRunEdit(threadKey);
  const saving = useRef(false);
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const editQueuedRun = useAtomCommand(threadEnvironment.editQueuedRun, { reportFailure: false });
  const composerDraftKey =
    threadKey === null
      ? null
      : queuedRunEdit === null
        ? threadKey
        : queuedEditDraftKey(threadKey, queuedRunEdit.runId);

  useEffect(() => {
    if (
      threadKey !== null &&
      queuedRunEdit !== null &&
      workflow !== null &&
      !workflow.queuedRuns.some((entry) => entry.run.id === queuedRunEdit.runId)
    ) {
      // Preserve the separate edit draft: returning it to normal Send would
      // accidentally recreate work already consumed by another client.
      setThreadComposerError(threadKey, CONSUMED_MESSAGE);
    }
  }, [queuedRunEdit, threadKey, workflow]);

  const cancelQueuedRunEdit = useCallback(() => {
    if (threadKey === null || saving.current) return;
    endQueuedRunEdit(threadKey);
    clearThreadComposerError(threadKey);
  }, [threadKey]);
  const onRemoveQueuedEditAttachment = useCallback(
    (attachmentId: string) => {
      if (threadKey === null || saving.current) return;
      removeQueuedRunEditAttachment(threadKey, attachmentId);
    },
    [threadKey],
  );

  const saveQueuedRunEdit = useCallback(async () => {
    if (thread === null || threadKey === null || saving.current) return;
    const edit = getQueuedRunEdit(threadKey);
    if (edit === null) return;
    const draftKey = queuedEditDraftKey(threadKey, edit.runId);
    let draftVersion = appAtomRegistry.get(composerDraftsAtom)[draftKey];
    const draft = getComposerDraftSnapshot(draftKey);
    const fail = (message: string) => setThreadComposerError(threadKey, message);
    const canSave = () => {
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return false;
      if (
        getQueuedRunEdit(threadKey) !== edit ||
        appAtomRegistry.get(composerDraftsAtom)[draftKey] !== draftVersion
      )
        return false;
      const currentWorkflow = appAtomRegistry.get(
        environmentThreadDetails.queueWorkflowAtom({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      );
      const queued = currentWorkflow?.queuedRuns.find(
        (entry) => entry.run.id === edit.runId && entry.messageId === edit.messageId,
      );
      if (!queued) {
        fail(CONSUMED_MESSAGE);
        return false;
      }
      const config = appAtomRegistry.get(serverEnvironment.configValueAtom(thread.environmentId));
      if (!config) return false;
      if (isModelSelectionUnavailable(config, queued.run.modelSelection, thread.projectId)) {
        fail(
          "This queued message's provider is disabled for this project or by your administrator. Your edit is still here.",
        );
        return false;
      }
      return true;
    };
    if (appAtomRegistry.get(composerContextImportsAtom)[draftKey] || !canSave()) return;
    const text = draft.text.trim();
    if (!text) {
      fail("A queued message cannot be left empty.");
      return;
    }
    if (
      edit.existingAttachments.length + draft.attachments.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      fail(`Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`);
      return;
    }
    const contextError = composerContextSendBlockReason(draft.context);
    if (contextError) {
      fail(contextError);
      return;
    }
    saving.current = true;
    setIsSavingQueuedEdit(true);
    try {
      const config = appAtomRegistry.get(serverEnvironment.configValueAtom(thread.environmentId));
      const prepared = await prepareTurnAttachments({
        environmentId: thread.environmentId,
        attachments: draft.attachments,
        supportsImageUploads: config?.environment.capabilities.attachmentUploads === true,
        persistUploadedReferences: async (attachments) => {
          if (!canSave()) return "abandon";
          replaceComposerDraftAttachments(draftKey, attachments);
          draftVersion = appAtomRegistry.get(composerDraftsAtom)[draftKey];
          await flushComposerDrafts();
          return "persisted";
        },
      });
      if (prepared.status !== "ready" || !canSave()) return;
      const payload = resolveQueuedEditPayload({
        edit,
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: prepared.attachments,
      });
      const replacesAttachments =
        draft.attachments.length > 0 ||
        JSON.stringify(edit.existingAttachments) !==
          JSON.stringify(edit.originalAttachments ?? edit.existingAttachments) ||
        JSON.stringify(payload.context) !== JSON.stringify(edit.context);
      const result = await editQueuedRun({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          runId: edit.runId,
          text,
          ...(replacesAttachments
            ? {
                edit: {
                  messageId: edit.messageId,
                  attachments: payload.attachments,
                  ...(payload.context ? { context: payload.context } : {}),
                },
              }
            : {}),
        },
      });
      if (result._tag !== "Success") {
        fail(
          "Could not save the queued message. It may have already started; your edit is still here.",
        );
        return;
      }
      if (
        getQueuedRunEdit(threadKey) !== edit ||
        appAtomRegistry.get(composerDraftsAtom)[draftKey] !== draftVersion
      ) {
        fail("Saved the earlier edit. Your newer changes are still here.");
        return;
      }
      endQueuedRunEdit(threadKey, { deferAttachmentCleanup: true });
      clearThreadComposerError(threadKey);
      scheduleUnusedComposerAttachmentCleanup(draft.attachments);
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "Could not save the queued message. Your edit is still here.",
      );
    } finally {
      saving.current = false;
      setIsSavingQueuedEdit(false);
    }
  }, [editQueuedRun, thread, threadKey]);

  return {
    composerDraftKey,
    queuedRunEdit,
    isSavingQueuedEdit,
    cancelQueuedRunEdit,
    onRemoveQueuedEditAttachment,
    saveQueuedRunEdit,
  };
}
