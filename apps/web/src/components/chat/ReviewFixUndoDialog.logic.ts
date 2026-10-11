import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { reviewFixUndo } from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ReviewUndoFixesResult, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { waitForRevertedMessage } from "../ChatView.logic";

/** Holds the send lock until review-fix rollback is observed, even if the dialog unmounts. */
export async function undoReviewFixes<E>(
  threadRef: ScopedThreadRef,
  undoFixes: () => Promise<AtomCommandResult<ReviewUndoFixesResult, E>>,
) {
  const threadKey = scopedThreadKey(threadRef);
  if (useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)) return false;
  const thread = appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef));
  const target = thread && reviewFixUndo(thread);
  const message = thread?.messages.findLast((message) => message.role === "user");
  if (!target || target.undoneTurns === 0 || !message) {
    throw new Error("The review fixes to undo are no longer available.");
  }
  useComposerDraftStore.setState((store) => ({
    rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(threadKey),
  }));
  let interrupted = false;
  try {
    await waitForRevertedMessage(threadRef, message.id, target.turnCount, async () => {
      const result = await undoFixes();
      if (result._tag === "Failure") {
        interrupted = isAtomCommandInterrupted(result);
        throw squashAtomCommandFailure(result);
      }
    });
    return true;
  } catch (error) {
    if (interrupted) return false;
    throw error;
  } finally {
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(threadKey);
      return { rewindingThreadKeys: remaining };
    });
  }
}
