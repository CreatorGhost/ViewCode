/**
 * Edits use a separate persisted draft. The key helper strips its native run-ID
 * suffix for environment routing; the normal draft is unchanged on Cancel.
 */
import type {
  ChatAttachment,
  OrchestrationMessageContext,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import type { QueuedRunEdit } from "./queued-run-edit-model";
export type { QueuedRunEdit } from "./queued-run-edit-model";
import { setThreadComposerError } from "./thread-composer-error";
import {
  composerDraftsAtom,
  clearComposerDraft,
  setComposerDraftContext,
  setComposerDraftQueuedRunEdit,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

export const queuedRunEditsAtom = Atom.make<Readonly<Record<string, QueuedRunEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-queued-run-edits"),
);

export { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";

export function getQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  if (threadKey === null) return null;
  return (
    appAtomRegistry.get(queuedRunEditsAtom)[threadKey] ??
    activePersistedEdit(threadKey, appAtomRegistry.get(composerDraftsAtom))
  );
}

function activePersistedEdit(
  threadKey: string,
  drafts: Readonly<Record<string, { readonly queuedRunEdit?: QueuedRunEdit }>>,
): QueuedRunEdit | null {
  for (const [key, draft] of Object.entries(drafts)) {
    const edit = draft.queuedRunEdit;
    if (edit?.active && key === queuedEditDraftKey(threadKey, edit.runId)) return edit;
  }
  return null;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEditsAtom);
  const drafts = useAtomValue(composerDraftsAtom);
  return threadKey === null ? null : (edits[threadKey] ?? activePersistedEdit(threadKey, drafts));
}

function setQueuedRunEdit(threadKey: string, edit: QueuedRunEdit | null): void {
  const current = appAtomRegistry.get(queuedRunEditsAtom);
  if (edit === null) {
    if (!current[threadKey]) return;
    const next = { ...current };
    delete next[threadKey];
    appAtomRegistry.set(queuedRunEditsAtom, next);
    return;
  }
  appAtomRegistry.set(queuedRunEditsAtom, { ...current, [threadKey]: edit });
}

const pendingBegins = new Map<string, number>();
let beginSequence = 0;

export async function beginQueuedRunEdit(threadKey: string, edit: QueuedRunEdit): Promise<void> {
  const sequence = ++beginSequence;
  pendingBegins.set(threadKey, sequence);
  try {
    // A missing in-memory key is not a fresh draft until disk hydration finishes.
    await waitForComposerDraftsLoaded();
    if (pendingBegins.get(threadKey) !== sequence) return;
    const draftKey = queuedEditDraftKey(threadKey, edit.runId);
    const existing = appAtomRegistry.get(composerDraftsAtom)[draftKey];
    const saved = existing?.queuedRunEdit;
    const restored =
      saved?.runId === edit.runId && saved.messageId === edit.messageId ? saved : null;
    if (saved !== undefined && restored === null) {
      setThreadComposerError(
        threadKey,
        "This saved edit belongs to a different queued message. Its draft has been preserved.",
      );
      return;
    }
    const previous = getQueuedRunEdit(threadKey);
    if (previous !== null && previous.runId !== edit.runId) {
      setComposerDraftQueuedRunEdit(queuedEditDraftKey(threadKey, previous.runId), {
        ...previous,
        active: false,
      });
    }
    if (existing === undefined) {
      setComposerDraftText(draftKey, edit.originalText);
      setComposerDraftContext(draftKey, edit.context);
    } else {
      setThreadComposerError(
        threadKey,
        queuedRunEditSourceChanged(restored ?? edit, edit)
          ? "Recovered your unsaved edit. The queued message changed since this edit began; review the current message and attachments before saving over it."
          : "Recovered your unsaved queued edit. Review it before saving; your normal draft is unchanged.",
      );
    }
    const next = {
      ...(restored ?? edit),
      originalAttachments: restored?.originalAttachments ?? edit.existingAttachments,
      active: true,
    };
    setComposerDraftQueuedRunEdit(draftKey, next);
    setQueuedRunEdit(threadKey, next);
  } catch (error) {
    setThreadComposerError(
      threadKey,
      error instanceof Error
        ? `Could not open the queued edit: ${error.message}`
        : "Could not open the queued edit. Your saved drafts are unchanged.",
    );
  } finally {
    if (pendingBegins.get(threadKey) === sequence) pendingBegins.delete(threadKey);
  }
}

export function queuedRunEditSourceChanged(
  saved: QueuedRunEdit,
  current: Pick<QueuedRunEdit, "originalText" | "existingAttachments" | "context">,
): boolean {
  return (
    saved.originalText !== current.originalText ||
    JSON.stringify(saved.originalAttachments ?? saved.existingAttachments) !==
      JSON.stringify(current.existingAttachments) ||
    JSON.stringify(saved.context) !== JSON.stringify(current.context)
  );
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  const next = {
    ...edit,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  };
  setComposerDraftQueuedRunEdit(queuedEditDraftKey(threadKey, edit.runId), next);
  setQueuedRunEdit(threadKey, next);
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  pendingBegins.delete(threadKey);
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  setQueuedRunEdit(threadKey, null);
}

/**
 * Attachments replace the message's list wholesale, so kept server attachments
 * are resent alongside the newly uploaded ones, in composer order.
 */
export function resolveQueuedEditPayload(input: {
  readonly edit: QueuedRunEdit;
  readonly draftContext: OrchestrationMessageContext | undefined;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploaded: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
} {
  const attachments = [...input.edit.existingAttachments, ...input.uploaded];
  const rebound = uploadedComposerContext(
    input.draftContext,
    input.draftAttachments,
    input.uploaded,
  );
  if (rebound === undefined) return { attachments, context: undefined };
  const liveIds = new Set(
    attachments.flatMap((attachment) =>
      "id" in attachment && attachment.id ? [attachment.id] : [],
    ),
  );
  const records = rebound.records.filter(
    (record) => !("attachmentId" in record) || liveIds.has(record.attachmentId),
  );
  return {
    attachments,
    context: records.length > 0 ? { version: 1, records } : undefined,
  };
}
