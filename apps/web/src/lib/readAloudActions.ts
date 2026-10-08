import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { getClientSettings } from "~/hooks/useSettings";
import type { Thread } from "~/types";
import { latestReadableReply, readAloudMessageKey } from "./readAloud.logic";
import { speakReadAloud } from "./readAloudPlayer";

/** "Read latest reply aloud" from the command palette or its keybinding. */
export function readLatestReplyAloud(thread: Thread): void {
  const reply = latestReadableReply(thread);
  if (!reply) return;
  const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  speakReadAloud(readAloudMessageKey(threadKey, reply.id), reply.text, getClientSettings());
}
