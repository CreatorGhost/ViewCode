import { StackActions, useNavigation } from "@react-navigation/native";
import {
  type ReviewFindingEntry,
  reviewFindingIdentity,
  selectReviewFixChat,
} from "@t3tools/client-runtime/review-findings";
import { CommandId, type EnvironmentId, MessageId, type ProjectId, type ReviewFindingsTarget, type ThreadId } from "@t3tools/contracts";
import { buildReviewFixMessage } from "@t3tools/shared/reviewFindings";
import * as Haptics from "expo-haptics";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../../../lib/commandMetadata";
import { useThreadShells } from "../../../state/entities";
import { markReviewFindingsSent, reviewFindingsCardKey } from "../../../state/review-findings";
import { enqueueThreadOutboxMessage } from "../../../state/thread-outbox";
import {
  createNewTaskDraft,
  mergeComposerDraftContent,
  updateComposerDraftSettings,
} from "../../../state/use-composer-drafts";

/** Where a review's findings go to be fixed: a chat, or a new chat's draft when there is none. */
export type ReviewFixChat =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly title: string }
  | {
      readonly kind: "new";
      readonly projectId: ProjectId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    };

/**
 * Fix with agent for one review, the way web does it: the request goes into a chat as the
 * reader's own message through the outbox, now or when the chat can take it if it is working,
 * with no dialog and no navigation; the findings are marked sent. The chat is the one the reader
 * came from (`fromThreadId`), else the one the review was started from or the one working on what
 * it reviewed (`selectReviewFixChat`). With no chat at all, a new chat's draft opens with the
 * request in it for the reader to send.
 */
export function useReviewFix(input: {
  readonly environmentId: EnvironmentId;
  readonly reviewThreadId: ThreadId;
  readonly reviewTitle: string;
  readonly fromThreadId: ThreadId | null;
  readonly target: ReviewFindingsTarget | null;
}) {
  const { environmentId, reviewThreadId, reviewTitle, fromThreadId, target } = input;
  const navigation = useNavigation();
  const shells = useThreadShells();
  const chat = useMemo((): ReviewFixChat | null => {
    if (target === null) return null;
    const threads = shells.filter((shell) => shell.environmentId === environmentId);
    const from =
      fromThreadId === null || fromThreadId === reviewThreadId
        ? undefined
        : threads.find((thread) => thread.id === fromThreadId);
    if (from !== undefined) return { kind: "thread", threadId: from.id, title: from.title };
    const choice = selectReviewFixChat({ reviewThreadId, projectId: null, target, threads });
    if (choice === null) return null;
    return choice.kind === "thread"
      ? { kind: "thread", threadId: choice.thread.id, title: choice.thread.title }
      : choice;
  }, [environmentId, fromThreadId, reviewThreadId, shells, target]);

  const fix = useCallback(
    async (
      selection: ReadonlyArray<ReviewFindingEntry>,
      /** A sheet asking replaces itself with the new chat rather than staying beneath it. */
      options?: { readonly replaceScreen?: boolean },
    ): Promise<void> => {
      if (selection.length === 0 || target === null || chat === null) return;
      const text = buildReviewFixMessage({
        reviewTitle,
        target,
        findings: selection.map((entry) => ({
          finding: entry.finding,
          needsChecking: entry.needsChecking,
        })),
      });
      const identities = selection.map((entry) => reviewFindingIdentity(entry.finding));
      const cardKey = reviewFindingsCardKey(environmentId, reviewThreadId);
      if (chat.kind === "new") {
        try {
          // A new chat has no thread to send to until its first message: the reader sends it.
          const draftKey = createNewTaskDraft({ environmentId, projectId: chat.projectId });
          updateComposerDraftSettings(draftKey, {
            workspaceSelection: {
              mode: "local",
              branch: chat.branch,
              worktreePath: chat.worktreePath,
            },
          });
          await mergeComposerDraftContent(draftKey, { text, attachments: [] });
          const params = {
            screen: "NewTaskDraft",
            params: { draftId: draftKey, environmentId, projectId: chat.projectId },
          } as const;
          if (options?.replaceScreen === true) {
            navigation.dispatch(StackActions.replace("NewTaskSheet", params));
          } else {
            navigation.navigate("NewTaskSheet", params);
          }
        } catch (error) {
          Alert.alert(
            "Could not open a chat for the fix",
            error instanceof Error ? error.message : "The new chat could not be written.",
          );
        }
        return;
      }
      const metadata = makeQueuedMessageMetadata();
      try {
        // The chat keeps its own model and modes.
        await enqueueThreadOutboxMessage({
          environmentId,
          threadId: chat.threadId,
          messageId: MessageId.make(metadata.messageId),
          commandId: CommandId.make(metadata.commandId),
          text,
          attachments: [],
          createdAt: metadata.createdAt,
        });
      } catch (error) {
        Alert.alert(
          "Could not send the fix",
          error instanceof Error ? error.message : "The message could not be queued.",
        );
        return;
      }
      markReviewFindingsSent(cardKey, identities, { threadId: chat.threadId, title: chat.title });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    [chat, environmentId, navigation, reviewThreadId, reviewTitle, target],
  );

  return { chat, fix };
}
