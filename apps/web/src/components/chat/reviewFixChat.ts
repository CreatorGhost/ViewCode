import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { reviewFixCandidates } from "@t3tools/client-runtime/review-findings";
import type {
  EnvironmentId,
  ProjectId,
  ReviewFindingsTarget,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readThreadShell, readThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";
import type { ReviewFixDestination } from "./reviewFixSentStore";
import type { reviewFindingsFixPrompt } from "./reviewPanel.logic";

/** A request for a chat's composer and the chip records its text refers to. */
export type ReviewFixRequest = ReturnType<typeof reviewFindingsFixPrompt>;

/** Where findings go to be fixed: a chat's composer, or a new chat's when there is none. */
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
 * with the records its chips refer to. Nothing is sent.
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
 * The chat that fixes a review's findings when the view has no chat beside it: the chat the review
 * was started from (its parent), else the chat most recently working on what it reviewed, else a
 * new chat on the reviewed checkout. Never another agent: child agents, the reviewer's own lenses
 * among them, are no chat to fix in.
 */
export function resolveReviewFixChat(input: {
  readonly environmentId: EnvironmentId;
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly target: ReviewFindingsTarget;
}): ReviewFixChat | null {
  const reviewer = readThreadShell(scopeThreadRef(input.environmentId, input.reviewThreadId));
  const parentId = reviewer?.kind === "sidechat" ? null : (reviewer?.parentThreadId ?? null);
  const parent =
    parentId === null ? null : readThreadShell(scopeThreadRef(input.environmentId, parentId));
  if (parent !== null && parent.archivedAt === null) {
    return { kind: "thread", ref: scopeThreadRef(input.environmentId, parent.id), title: parent.title };
  }
  const projectId = input.projectId ?? reviewer?.projectId ?? null;
  if (projectId === null) return null;
  const reviewThread = reviewer ?? {
    id: input.reviewThreadId,
    projectId,
    branch: null,
    worktreePath: null,
  };
  const [chat] = reviewFixCandidates({
    reviewThread,
    target: input.target,
    threads: readThreadShells().filter((shell) => shell.environmentId === input.environmentId),
  }).candidates;
  if (chat !== undefined) {
    return { kind: "thread", ref: scopeThreadRef(input.environmentId, chat.id), title: chat.title };
  }
  const local = input.target.kind === "local";
  return {
    kind: "new",
    projectRef: scopeProjectRef(input.environmentId, projectId),
    branch: local ? (reviewer?.branch ?? null) : null,
    worktreePath: local ? (reviewer?.worktreePath ?? null) : null,
  };
}

/**
 * Puts a fix request into a chat's composer and goes there, unsent: an existing chat's, or a new
 * chat's. Resolves to where it went, or null when no chat could be opened.
 */
export function useSendReviewFixToChat(): (
  chat: ReviewFixChat,
  request: ReviewFixRequest,
) => Promise<ReviewFixDestination | null> {
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  return useCallback(
    async (chat, request) => {
      if (chat.kind === "thread") {
        writeReviewFixToComposer(chat.ref, request);
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(chat.ref) });
        return { threadId: chat.ref.threadId, title: chat.title };
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
      writeReviewFixToComposer(opened.draftId, request);
      return { threadId: opened.threadId, title: "New chat" };
    },
    [navigate, newThread],
  );
}
