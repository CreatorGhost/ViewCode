import type { EnvironmentId, SpeakMode, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  deriveUnsettledTurnId,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import { useEnvironmentServerConfig } from "../../state/entities";
import { readAloudKey } from "./ReadAloudButton";
import { replyToSpeak } from "./speakableText";
import { speak, stopSpeakingIf } from "./speech";

/** The newest assistant reply, once its turn has settled; null while one is still being written. */
function latestFinishedReply(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
) {
  const unsettledTurnId = deriveUnsettledTurnId(latestTurn);
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const { message } = entry;
    return message.streaming || (message.turnId !== null && message.turnId === unsettledTurnId)
      ? null
      : message;
  }
  return null;
}

/**
 * Speak mode for the open thread: reads a reply that finishes while this thread is on screen and
 * the app is in front. Replies already there when the thread opened are never read, and leaving
 * the thread stops its reading.
 */
export function useSpokenReplies(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly latestTurn: ThreadFeedLatestTurn | null;
}) {
  const mode: SpeakMode =
    useEnvironmentServerConfig(input.environmentId)?.settings.speakMode ?? "off";
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const handled = useRef<{ readonly threadKey: string; id: string | null } | null>(null);
  const reply = latestFinishedReply(input.feed, input.latestTurn);

  useEffect(() => {
    if (handled.current?.threadKey !== threadKey) {
      handled.current = { threadKey, id: reply?.id ?? null };
      return;
    }
    // Turning speak mode on later must not read a reply that finished while it was off.
    if (mode === "off") {
      handled.current.id = reply?.id ?? handled.current.id;
      return;
    }
    const next = replyToSpeak({ mode, reply, handledId: handled.current.id });
    if (next === null) return;
    handled.current.id = next.id;
    if (AppState.currentState === "active") speak(readAloudKey(threadKey, next.id), next.text);
  }, [mode, reply, threadKey]);

  useEffect(() => () => stopSpeakingIf((key) => key.startsWith(`${threadKey}\0`)), [threadKey]);
}
