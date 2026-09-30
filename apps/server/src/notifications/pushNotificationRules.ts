import type { PushNotificationCategory, UsageResumePayload } from "@t3tools/contracts";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { formatResumeAt, classifyLimitError } from "@t3tools/shared/usageLimit";

/**
 * Which thread changes buzz the phone, decided from what the environment has
 * observed about each thread since it started watching. Pure so the rules can
 * be tested without the event stream.
 */

export type PushEventKind =
  | "finished"
  | "failed"
  | "needs-approval"
  | "needs-input"
  | "usage-limit"
  | "usage-limit-gave-up"
  | "resumed";

export const PUSH_EVENT_CATEGORY: Record<PushEventKind, PushNotificationCategory> = {
  finished: "finished",
  failed: "finished",
  "needs-approval": "needsYou",
  "needs-input": "needsYou",
  "usage-limit": "usageLimit",
  "usage-limit-gave-up": "usageLimit",
  resumed: "resumed",
};

/** What the service remembers per thread between events. */
export interface ThreadTrack {
  readonly phase: AgentAwarenessPhase | null;
  /** The newest turn seen for the thread; sticky because the shell can drop it once a turn settles. */
  readonly turnId: string | null;
  /** The turn a finished/failed notification went out for. */
  readonly finishedTurnId: string | null;
  /** The turn a usage-limit notification went out for. */
  readonly limitTurnId: string | null;
}

export interface ThreadObservation {
  readonly phase: AgentAwarenessPhase | null;
  readonly turnId: string | null;
  readonly turnState: string | null;
  readonly lastError: string | null;
}

const WORKING: ReadonlySet<AgentAwarenessPhase | null> = new Set([
  "running",
  "waiting_for_approval",
  "waiting_for_input",
]);

function emptyTrack(): ThreadTrack {
  return { phase: null, turnId: null, finishedTurnId: null, limitTurnId: null };
}

/**
 * A thread's new state against what was last seen. Nothing fires on the first
 * sighting (a restart must not replay old work), a finish needs the thread to
 * have been seen working (a session booting at "ready" is not a finished turn),
 * and one turn finishes once. A turn ended by a usage limit or a passing
 * throttle is left to the usage-resume path, which knows when work continues;
 * one the user stopped says nothing.
 */
export function decideThreadNotification(
  previous: ThreadTrack | undefined,
  observed: ThreadObservation,
): { readonly next: ThreadTrack; readonly kind: PushEventKind | null } {
  const base = previous ?? emptyTrack();
  const turnId = observed.turnId ?? base.turnId;
  const next: ThreadTrack = { ...base, phase: observed.phase, turnId };
  if (previous === undefined) return { next, kind: null };

  if (observed.phase === "waiting_for_approval" || observed.phase === "waiting_for_input") {
    if (previous.phase === observed.phase) return { next, kind: null };
    return {
      next,
      kind: observed.phase === "waiting_for_approval" ? "needs-approval" : "needs-input",
    };
  }

  if (observed.phase !== "completed" && observed.phase !== "failed") return { next, kind: null };
  if (!WORKING.has(previous.phase)) return { next, kind: null };
  if (turnId !== null && previous.finishedTurnId === turnId) return { next, kind: null };
  const settled: ThreadTrack = { ...next, finishedTurnId: turnId };
  if (observed.turnState === "interrupted") return { next: settled, kind: null };
  if (classifyLimitError(observed.lastError) !== null) return { next: settled, kind: null };
  return { next: settled, kind: observed.phase === "failed" ? "failed" : "finished" };
}

/**
 * A `viewcode.usage-resume` note. The limit notifies once per turn (a busy
 * thread's re-armed schedule is the same limit); only a resume ViewCode ran by
 * itself after a real limit notifies, not the user's Resume now or a throttle
 * retry.
 */
export function decideUsageResumeNotification(
  previous: ThreadTrack | undefined,
  note: {
    readonly payload: UsageResumePayload;
    readonly summary: string;
    readonly turnId: string | null;
  },
  autoResumeSummary: string,
): { readonly next: ThreadTrack; readonly kind: PushEventKind | null } {
  const base = previous ?? emptyTrack();
  const turnId = note.turnId ?? base.turnId;
  switch (note.payload.state) {
    case "scheduled":
    case "reset-known":
    case "unknown":
    case "gave-up": {
      const kind = note.payload.state === "gave-up" ? "usage-limit-gave-up" : "usage-limit";
      if (turnId !== null && base.limitTurnId === turnId && kind === "usage-limit") {
        return { next: base, kind: null };
      }
      return { next: { ...base, turnId, limitTurnId: turnId }, kind };
    }
    case "resumed":
      return { next: base, kind: note.summary === autoResumeSummary ? "resumed" : null };
    default:
      return { next: base, kind: null };
  }
}

const TITLE_MAX = 80;
const BODY_MAX = 160;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The event in a few words; never message text, errors or anything else from the thread. */
export function describePushEvent(
  kind: PushEventKind,
  payload: UsageResumePayload | null,
  nowMs: number,
): string {
  switch (kind) {
    case "finished":
      return "Finished";
    case "failed":
      return "Stopped with an error";
    case "needs-approval":
      return "Needs your approval";
    case "needs-input":
      return "Has a question for you";
    case "usage-limit": {
      if (payload?.state === "scheduled" && payload.resumeAt !== undefined) {
        return `Usage limit reached. Continuing ${formatResumeAt(payload.resumeAt, nowMs)}.`;
      }
      if (payload?.resetsAt !== undefined) {
        return `Usage limit reached. Resets ${formatResumeAt(payload.resetsAt, nowMs)}.`;
      }
      return "Usage limit reached. Send a message to continue.";
    }
    case "usage-limit-gave-up":
      return "Still out of usage; automatic resume stopped.";
    case "resumed":
      return "Usage limit reset. Continuing the task.";
  }
}

/**
 * Title and body. A child agent's notification is titled with its lead, so an
 * agent tree reads as one conversation in the shade; tapping still opens the
 * agent that needs you.
 */
export function formatPushNotification(input: {
  readonly kind: PushEventKind;
  readonly threadTitle: string;
  readonly leadTitle: string | null;
  readonly payload: UsageResumePayload | null;
  readonly nowMs: number;
}): { readonly title: string; readonly body: string } {
  const event = describePushEvent(input.kind, input.payload, input.nowMs);
  if (input.leadTitle === null) {
    return { title: clip(input.threadTitle, TITLE_MAX), body: clip(event, BODY_MAX) };
  }
  return {
    title: clip(input.leadTitle, TITLE_MAX),
    body: clip(`${clip(input.threadTitle, 60)}: ${event}`, BODY_MAX),
  };
}
