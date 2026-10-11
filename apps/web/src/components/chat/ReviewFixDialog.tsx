import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ReviewFindingsTarget, ReviewFindingToFix, ScopedThreadRef } from "@t3tools/contracts";
import { buildReviewFixMessage } from "@t3tools/shared/reviewFindings";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { latestCompletedToolActivityId, useQueuedMessageStore } from "../../queuedMessageStore";
import { readThread, useThreadShell, useThreadShells } from "../../state/entities";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { waitForThreadShell } from "../agents/useCreateChildAgent";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { reviewFixCandidates } from "./reviewFix.logic";
import { useReviewFixSentStore } from "./reviewFixSentStore";

const NEW_SESSION = "new";

export interface ReviewFixItem {
  /** The finding's key on its card, for marking it sent. */
  readonly key: string;
  readonly item: ReviewFindingToFix;
}

/**
 * Where findings go to be fixed: a session already working on the reviewed change, or a new one.
 * An existing session gets them through the composer's queue, so a busy one takes them at its
 * next stopping point the way a queued message would; a new one is started by the server on the
 * pull request's head in its own worktree, and opens.
 */
export function ReviewFixDialog({
  reviewThreadRef,
  cardKey,
  target,
  items,
  onClose,
}: {
  reviewThreadRef: ScopedThreadRef;
  cardKey: string;
  target: ReviewFindingsTarget;
  items: ReadonlyArray<ReviewFixItem>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { environmentId } = reviewThreadRef;
  const reviewThread = useThreadShell(reviewThreadRef);
  const shells = useThreadShells();
  const { candidates, preselectedId } = useMemo(
    () =>
      reviewThread === null
        ? { candidates: [], preselectedId: null }
        : reviewFixCandidates({
            reviewThread,
            target,
            threads: shells.filter((shell) => shell.environmentId === environmentId),
          }),
    [environmentId, reviewThread, shells, target],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? preselectedId ?? (candidates.length === 0 ? NEW_SESSION : null);
  const startFixThread = useAtomCommand(reviewEnvironment.startFixThread, {
    reportFailure: false,
  });
  const markSent = useReviewFixSentStore((state) => state.markSent);
  const [pending, setPending] = useState(false);
  const count = items.length;
  const keys = items.map((entry) => entry.key);
  const findings = items.map((entry) => entry.item);

  const send = async () => {
    if (reviewThread === null || selected === null || pending) return;
    if (selected === NEW_SESSION) {
      setPending(true);
      const result = await startFixThread({
        environmentId,
        input: { reviewThreadId: reviewThreadRef.threadId, target, findings: [...findings] },
      });
      setPending(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not start a session to fix the findings",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      markSent(cardKey, keys, result.value);
      onClose();
      const threadRef = scopeThreadRef(environmentId, result.value.threadId);
      await waitForThreadShell(threadRef);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      return;
    }
    const thread = candidates.find((candidate) => candidate.id === selected);
    if (thread === undefined) return;
    const threadRef = scopeThreadRef(environmentId, thread.id);
    useQueuedMessageStore.getState().enqueue(scopedThreadKey(threadRef), {
      prompt: buildReviewFixMessage({ reviewTitle: reviewThread.title, target, findings }),
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      // The session keeps its own model and modes.
      sendSettings: {
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        promptEffort: null,
      },
      queuedAfterToolActivityId: latestCompletedToolActivityId(
        readThread(threadRef)?.activities ?? [],
      ),
      createdAt: new Date().toISOString(),
    });
    markSent(cardKey, keys, { threadId: thread.id, title: thread.title });
    onClose();
    toastManager.add({
      type: "success",
      title: `Sent to ${thread.title}`,
      description: "It goes out now, or at the session's next stopping point if it is working.",
      actionProps: {
        children: "Open session",
        onClick: () => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
        },
      },
    });
  };

  const newSessionDescription =
    target.kind === "pull-request"
      ? `A new thread on PR #${target.number}'s branch in its own worktree, linked to the pull request. Your checkout stays as it is.`
      : "A new thread on the checkout this review looked at.";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Fix {count === 1 ? "this finding" : `${count} findings`} in a session
            </DialogTitle>
            <DialogDescription>
              The session checks each finding against the code first, fixes the ones that hold and
              says which it skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <RadioGroup
              aria-label="Session"
              value={selected ?? ""}
              onValueChange={(value) => setPicked(typeof value === "string" ? value : null)}
            >
              {candidates.map((thread) => (
                <label
                  key={thread.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
                >
                  <Radio value={thread.id} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{thread.title}</span>
                    <span className="text-muted-foreground text-xs">
                      {target.kind === "pull-request"
                        ? "Works on this pull request"
                        : "Works on this checkout"}{" "}
                      · {formatRelativeTimeLabel(thread.updatedAt)}
                    </span>
                  </span>
                </label>
              ))}
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
                <Radio value={NEW_SESSION} className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">New session</span>
                  <span className="text-muted-foreground text-xs">{newSessionDescription}</span>
                </span>
              </label>
            </RadioGroup>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || selected === null || reviewThread === null}>
              {pending ? "Starting..." : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
