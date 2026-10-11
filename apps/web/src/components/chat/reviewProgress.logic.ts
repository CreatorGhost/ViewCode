import { workLogEntryIsToolLike } from "@t3tools/client-runtime/work-log/presentation";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveWorkLogEntries } from "../../session-logic";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";

/** How long a review has run, to the minute: "just started", "6 min", "1 h 5 min". */
export function formatReviewElapsed(durationMs: number): string {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

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

const MAX_ERROR_CHARS = 140;

/** A provider's error cut to its first line, short enough for one status line. */
export function shortReviewError(error: string | null): string {
  const line = error?.split("\n").find((part) => part.trim().length > 0)?.trim() ?? "";
  if (line.length === 0) return "the reviewer stopped with an error";
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…` : line;
}
