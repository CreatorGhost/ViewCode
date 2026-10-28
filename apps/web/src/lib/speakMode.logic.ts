import type { SpeakMode } from "@t3tools/contracts";
import type { EnvironmentThread as Thread } from "@t3tools/client-runtime/viewcodeThread";

import { latestReadableReply, readAloudMessageKey } from "./readAloud.logic";

export const SPEAK_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: SpeakMode;
  readonly label: string;
}> = [
  { mode: "off", label: "Off" },
  { mode: "summary", label: "Summary" },
  { mode: "full", label: "Full reply" },
];

export function speakModeLabel(mode: SpeakMode): string {
  return SPEAK_MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? mode;
}

type SpeakableThread = Pick<Thread, "messages" | "latestTurn" | "session">;

/**
 * What speak mode reads for a thread's latest turn once it has completed: the server's spoken
 * summary in "summary" (null until it arrives), the whole final reply in "full".
 */
export function speakModeUtterance(
  mode: SpeakMode,
  thread: SpeakableThread,
): { readonly turnId: string; readonly messageId: string; readonly text: string } | null {
  if (mode === "off") return null;
  const turn = thread.latestTurn;
  if (turn?.state !== "completed") return null;
  const reply = latestReadableReply(thread);
  if (reply === null || reply.turnId !== turn.turnId) return null;
  const text = mode === "summary" ? (reply.spokenSummary?.trim() ?? "") : reply.text;
  return text.length > 0 ? { turnId: turn.turnId, messageId: reply.id, text } : null;
}

/**
 * Speaks each turn that completes in the thread on screen, once. A turn that had already finished
 * when the thread was opened, or while speak mode was off, stays silent, so opening a thread or
 * turning speak mode on never reads an old reply. `observe` is called with the open thread on
 * every change; switching threads starts over for the new one.
 */
export function createSpeakModeAutoplay(speak: (key: string, text: string) => void) {
  let threadKey: string | null = null;
  let baselined = false;
  const silentTurns = new Set<string>();
  const spokenTurns = new Set<string>();
  return function observe(input: {
    readonly threadKey: string | null;
    readonly mode: SpeakMode;
    readonly thread: SpeakableThread | null;
  }): void {
    if (input.threadKey !== threadKey) {
      threadKey = input.threadKey;
      baselined = false;
    }
    const { thread } = input;
    if (threadKey === null || thread === null) return;
    const turn = thread.latestTurn;
    const settled = turn !== null && turn.state !== "running";
    if (!baselined) {
      baselined = true;
      if (settled) silentTurns.add(`${threadKey}:${turn.turnId}`);
      return;
    }
    if (input.mode === "off") {
      if (settled) silentTurns.add(`${threadKey}:${turn.turnId}`);
      return;
    }
    const utterance = speakModeUtterance(input.mode, thread);
    if (utterance === null) return;
    const turnKey = `${threadKey}:${utterance.turnId}`;
    if (silentTurns.has(turnKey) || spokenTurns.has(turnKey)) return;
    spokenTurns.add(turnKey);
    speak(readAloudMessageKey(threadKey, utterance.messageId), utterance.text);
  };
}
