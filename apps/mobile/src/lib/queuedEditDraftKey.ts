// Keep the existing persisted key format. Native run IDs contain colons, so
// environment routing must first recover the thread key before this suffix.
const QUEUED_EDIT_DRAFT_MARKER = "~queued-edit~";

export function queuedEditDraftKey(threadKey: string, runId: string): string {
  return `${threadKey}${QUEUED_EDIT_DRAFT_MARKER}${runId}`;
}

export function queuedEditThreadKey(draftKey: string): string | null {
  const marker = draftKey.indexOf(QUEUED_EDIT_DRAFT_MARKER);
  return marker > 0 ? draftKey.slice(0, marker) : null;
}

export function isQueuedEditDraftKey(draftKey: string): boolean {
  return queuedEditThreadKey(draftKey) !== null;
}
