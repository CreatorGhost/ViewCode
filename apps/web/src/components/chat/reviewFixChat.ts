import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { selectReviewFixChat } from "@t3tools/client-runtime/review-findings";
import type {
  EnvironmentId,
  ProjectId,
  ReviewFindingsTarget,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId } from "../../lib/utils";
import { latestCompletedToolActivityId, useQueuedMessageStore } from "../../queuedMessageStore";
import { readThread, readThreadShell, readThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useTimelineMessageFocusStore } from "../../timelineMessageFocusStore";
import { toastManager } from "../ui/toast";
import type { ReviewFixDestination } from "./reviewFixSentStore";
import type { reviewFindingsFixPrompt } from "./reviewPanel.logic";

/** A fix request and the chip records its text refers to. */
export type ReviewFixRequest = ReturnType<typeof reviewFindingsFixPrompt>;

/** Where findings go to be fixed: a chat, or a new chat's draft when there is none. */
export type ReviewFixChat =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef; readonly title: string }
  | {
      readonly kind: "new";
      readonly projectRef: ScopedProjectRef;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    };

/**
 * Leaves the request at the end of a composer, after whatever the reader already typed there,
 * with the records its chips refer to. Only for a new chat's draft, which has no thread to send to.
 */
export function writeReviewFixToComposer(
  target: ComposerThreadTarget,
  request: ReviewFixRequest,
): void {
  const store = useComposerDraftStore.getState();
  // The chips' records go in first, so the text that refers to them finds them.
  for (const comment of request.comments) {
    store.addReviewComment(target, comment, { appendReference: false });
  }
  const current = store.getComposerDraft(target)?.prompt.trimEnd() ?? "";
  store.setPrompt(target, current.length > 0 ? `${current}\n\n${request.prompt}` : request.prompt);
}

/**
 * Sends the request into a chat as the reader's own message, through the chat's queue: now when
 * the chat is idle, at its next stopping point while it works, as a message typed there would.
 * The chat's own model and modes send it. Resolves to the message, for linking to it.
 */
export function sendReviewFixToChat(
  ref: ScopedThreadRef,
  title: string,
  request: ReviewFixRequest,
): ReviewFixDestination | null {
  const thread = readThreadShell(ref);
  if (thread === null) return null;
  const messageId = newMessageId();
  useQueuedMessageStore.getState().enqueue(scopedThreadKey(ref), {
    messageId,
    prompt: request.prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [...request.comments],
    sendSettings: {
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      promptEffort: null,
    },
    queuedAfterToolActivityId: latestCompletedToolActivityId(readThread(ref)?.activities ?? []),
    createdAt: new Date().toISOString(),
  });
  return { threadId: ref.threadId, title, messageId };
}

/** The chat that fixes a review's findings when the view has no chat beside it. */
export function resolveReviewFixChat(input: {
  readonly environmentId: EnvironmentId;
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly target: ReviewFindingsTarget;
}): ReviewFixChat | null {
  const choice = selectReviewFixChat({
    reviewThreadId: input.reviewThreadId,
    projectId: input.projectId,
    target: input.target,
    threads: readThreadShells().filter((shell) => shell.environmentId === input.environmentId),
  });
  if (choice === null) return null;
  return choice.kind === "thread"
    ? {
        kind: "thread",
        ref: scopeThreadRef(input.environmentId, choice.thread.id),
        title: choice.thread.title,
      }
    : {
        kind: "new",
        projectRef: scopeProjectRef(input.environmentId, choice.projectId),
        branch: choice.branch,
        worktreePath: choice.worktreePath,
      };
}

/**
 * Brings a fix that was sent into view: its message in the chat, which is scrolled to where it
 * already shows and opened otherwise. A chat already on screen is never navigated away from.
 */
export function useRevealReviewFix(): (
  environmentId: EnvironmentId,
  destination: ReviewFixDestination,
) => void {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    (environmentId, destination) => {
      const ref = scopeThreadRef(environmentId, destination.threadId);
      if (destination.messageId !== undefined) {
        useTimelineMessageFocusStore.getState().focus(scopedThreadKey(ref), destination.messageId);
      }
      const onScreen = router.state.matches.some(
        (match) => (match.params as { threadId?: string }).threadId === destination.threadId,
      );
      if (!onScreen) {
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      }
    },
    [navigate, router],
  );
}

/**
 * Fix with agent: sends the request into a chat and says so, or for want of any chat opens a new
 * one with the request in its message box. Resolves to where it went, or null when nothing could
 * take it.
 */
export function useSendReviewFixToChat(): (
  environmentId: EnvironmentId,
  chat: ReviewFixChat,
  request: ReviewFixRequest,
) => Promise<ReviewFixDestination | null> {
  const newThread = useNewThreadHandler();
  const reveal = useRevealReviewFix();
  return useCallback(
    async (environmentId, chat, request) => {
      if (chat.kind === "thread") {
        const sent = sendReviewFixToChat(chat.ref, chat.title, request);
        if (sent === null) {
          toastManager.add({
            type: "error",
            title: "Could not send the fix",
            description: `${chat.title} is not loaded. Open it, then try again.`,
          });
          return null;
        }
        toastManager.add({
          type: "success",
          title: `Sent to ${chat.title}`,
          description: "It goes out now, or when the chat's current step ends.",
          actionProps: { children: "View", onClick: () => reveal(environmentId, sent) },
        });
        return sent;
      }
      const opened = await newThread(chat.projectRef, {
        branch: chat.branch,
        worktreePath: chat.worktreePath,
      }).catch(() => null);
      if (opened === null) {
        toastManager.add({
          type: "error",
          title: "Could not open a chat for the fix",
          description: "Open a chat on this project, then use Fix with agent again.",
        });
        return null;
      }
      // A new chat has no thread to send to until its first message: the reader sends it.
      writeReviewFixToComposer(opened.draftId, request);
      toastManager.add({
        type: "success",
        title: "Opened a new chat with the fix",
        description: "No chat was working on this change. Read the request over, then send.",
      });
      return { threadId: opened.threadId, title: "the new chat" };
    },
    [newThread, reveal],
  );
}
