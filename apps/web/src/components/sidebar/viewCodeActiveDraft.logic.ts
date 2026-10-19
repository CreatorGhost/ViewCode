import type { EnvironmentId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  type ComposerThreadDraftState,
  DraftId,
  type DraftSessionState,
} from "../../composerDraftStore";

/** A draft is local until promotion; the native shell wins as soon as it arrives. */
export function resolveViewCodeActiveDraft(input: {
  readonly draftId: string | null;
  readonly session: DraftSessionState | null;
  readonly projectRefs: readonly ScopedProjectRef[];
  readonly threads: readonly { readonly environmentId: EnvironmentId; readonly id: ThreadId }[];
}): { readonly draftId: DraftId; readonly session: DraftSessionState } | null {
  const { session } = input;
  if (
    input.draftId === null ||
    session === null ||
    session.promotedTo != null ||
    !input.projectRefs.some(
      (ref) => ref.environmentId === session.environmentId && ref.projectId === session.projectId,
    ) ||
    input.threads.some(
      (thread) => thread.environmentId === session.environmentId && thread.id === session.threadId,
    )
  ) {
    return null;
  }
  return { draftId: DraftId.make(input.draftId), session };
}

/** Freeze this when opening the draft; typing should not repaint a navigation label. */
export function viewCodeActiveDraftTitle(composer: ComposerThreadDraftState | null): string {
  const prompt = replaceComposerContextReferences(composer?.prompt ?? "", (ref) => ref.label)
    .trim()
    .split("\n", 1)[0];
  return prompt || "New thread";
}
