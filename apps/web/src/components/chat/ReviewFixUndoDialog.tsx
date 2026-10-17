import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { undoReviewFixes } from "./ReviewFixUndoDialog.logic";

/** Asks the focused chat to offer undoing its review fixes (from the command palette). */
export const REVIEW_FIX_UNDO_OPEN_EVENT = "viewcode:review-fix-undo-open";

/**
 * Confirms undoing what a review fix session changed: the server reverts the session to its
 * checkpoint before the fix, conversation and files, the way "Edit from here" does.
 */
export function ReviewFixUndoDialog({
  threadRef,
  undoneTurns,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  undoneTurns: number;
  onClose: () => void;
}) {
  const undoFixes = useAtomCommand(reviewEnvironment.undoFixes, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const undo = async () => {
    if (pending) return;
    setPending(true);
    try {
      const completed = await undoReviewFixes(threadRef, (commandId) =>
        undoFixes({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, commandId },
        }),
      );
      if (completed) onClose();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not undo the review fixes",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo review fixes?</AlertDialogTitle>
          <AlertDialogDescription>
            Reverts this session to before the fixes: {undoneTurns}{" "}
            {undoneTurns === 1 ? "turn" : "turns"} and their file changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={pending} onClick={() => void undo()}>
            {pending ? "Undoing..." : "Undo fixes"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
