import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ModelSelection, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useSidechatDockStore } from "../../sidechatDockStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SIDECHAT_TITLE, sidechatTitleFromQuestion } from "./sidechat.logic";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

function reportFailure(title: string, failure: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: failure instanceof Error ? failure.message : "An error occurred.",
    }),
  );
}

/**
 * Side chat commands. The server hands the parent's context to the side chat
 * on its first turn, so asking only needs a thread linked to its parent and
 * the question; the parent is never written to.
 */
export function useSidechatActions() {
  const navigate = useNavigate();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });

  /** Creates a side chat under `parent` and sends its first question. Resolves to its id. */
  const ask = useCallback(
    async (input: {
      readonly parent: EnvironmentThreadShell;
      readonly question: string;
      readonly modelSelection: ModelSelection;
    }): Promise<ThreadId | null> => {
      const { parent, question, modelSelection } = input;
      const parentRef = scopeThreadRef(parent.environmentId, parent.id);
      const threadId = newThreadId();
      const created = await createThread({
        environmentId: parent.environmentId,
        input: {
          threadId,
          projectId: parent.projectId,
          title: sidechatTitleFromQuestion(question) || SIDECHAT_TITLE,
          modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: "default",
          branch: parent.branch,
          worktreePath: parent.worktreePath,
          parentThreadId: parent.id,
          kind: "sidechat",
        },
      });
      if (created._tag === "Failure") {
        if (!isAtomCommandInterrupted(created)) {
          reportFailure("Could not start side chat", squashAtomCommandFailure(created));
        }
        return null;
      }
      useSidechatDockStore.getState().setActive(parentRef, threadId);
      const sent = await startTurn({
        environmentId: parent.environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: question, attachments: [] },
          modelSelection,
          runtimeMode: parent.runtimeMode,
          interactionMode: "default",
        },
      });
      if (sent._tag === "Failure" && !isAtomCommandInterrupted(sent)) {
        reportFailure("Could not send question", squashAtomCommandFailure(sent));
      }
      return threadId;
    },
    [createThread, startTurn],
  );

  /** Follow-up in an existing side chat. The model picker's choice rides along. */
  const reply = useCallback(
    async (input: {
      readonly threadRef: ScopedThreadRef;
      readonly text: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: EnvironmentThreadShell["runtimeMode"];
    }) => {
      const result = await startTurn({
        environmentId: input.threadRef.environmentId,
        input: {
          threadId: input.threadRef.threadId,
          message: { messageId: newMessageId(), role: "user", text: input.text, attachments: [] },
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not send question", squashAtomCommandFailure(result));
      }
    },
    [startTurn],
  );

  const stop = useCallback(
    async (threadRef: ScopedThreadRef) => {
      await interruptTurn({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    },
    [interruptTurn],
  );

  /** "Open as full thread": clears the marker so it becomes an ordinary thread, then opens it. */
  const promote = useCallback(
    async (threadRef: ScopedThreadRef, parentRef: ScopedThreadRef) => {
      const result = await updateMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, kind: null },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not open side chat", squashAtomCommandFailure(result));
        }
        return;
      }
      useSidechatDockStore.getState().setActive(parentRef, null);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      });
    },
    [navigate, updateMetadata],
  );

  return { ask, reply, stop, promote };
}
