import { workLogEntryIsToolLike } from "@t3tools/client-runtime/work-log/presentation";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveWorkLogEntries } from "../../session-logic";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";

// A step is one of the reviewer's last tool calls; older work cannot be the current step.
const RECENT_ACTIVITIES = 40;

/**
 * The reviewer's current step in the words the chat's live activity row uses ("Reading
 * retry.ts"), from its latest tool call; null before it calls any.
 */
export function reviewWorkLine(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  workspaceRoot: string | undefined,
): string | null {
  const entries = deriveWorkLogEntries(activities.slice(-RECENT_ACTIVITIES));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!workLogEntryIsToolLike(entry) || entry.tone === "thinking") continue;
    return liveWorkEntryLabel(entry, workspaceRoot, index === entries.length - 1);
  }
  return null;
}
