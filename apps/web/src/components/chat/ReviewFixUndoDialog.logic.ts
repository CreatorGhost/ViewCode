import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { reviewFixUndo } from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ReviewUndoFixesResult, type ScopedThreadRef } from "@t3tools/contracts";

import * as Option from "effect/Option";
import { randomUUID } from "../../lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { waitForRevertedMessage } from "../ChatView.logic";

/** Holds the send lock until review-fix rollback is observed, even if the dialog unmounts. */
export async function undoReviewFixes<E>(
  threadRef: ScopedThreadRef,
  undoFixes: (commandId: CommandId) => Promise<AtomCommandResult<ReviewUndoFixesResult, E>>,
) {
  const threadKey = scopedThreadKey(threadRef);
  if (useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)) return false;
  const projection = Option.getOrNull(appAtomRegistry.get(environmentThreadDetails.stateAtom(threadRef)).data);
  const target = projection === null ? null : reviewFixUndo({
    activities:[...projection.turnItems,...projection.visibleTurnItems.map((row) => row.item)].flatMap((item) => item.type === "system_notice" && item.viewcodeActivity !== undefined ? [item.viewcodeActivity] : []),
    checkpoints:projection.runs.filter((run) => run.status !== "rolled_back").map((run) => ({checkpointTurnCount:run.ordinal})),
  });
  const message = projection?.messages.findLast((message) => message.role === "user" && projection.runs.some((run) => run.id === message.runId && run.status !== "rolled_back"));
  if (!target || target.undoneTurns === 0 || !message) {
    throw new Error("The review fixes to undo are no longer available.");
  }
  useComposerDraftStore.setState((store) => ({
    rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(threadKey),
  }));
  const commandId = CommandId.make(randomUUID());
  let interrupted = false;
  try {
    await waitForRevertedMessage(threadRef, message.id, target.turnCount, commandId, async () => {
      const result = await undoFixes(commandId);
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
