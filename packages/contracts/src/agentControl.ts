import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * User control over ViewCode agents (agent-to-agent messaging). Stopping an
 * agent that belongs to an agent tree pauses it: messages and replies to it
 * are held in its queue instead of waking it, until the user resumes it, types
 * a prompt into it, or discards the held work. The server keeps this in
 * memory only; a restart forgets queues and pauses.
 */

/** `thread` acts on one agent; `tree` on its whole agent tree (root and all descendants). */
export const AgentControlScope = Schema.Literals(["thread", "tree"]);
export type AgentControlScope = typeof AgentControlScope.Type;

export const AgentControlInput = Schema.Struct({
  threadId: ThreadId,
  scope: AgentControlScope,
});
export type AgentControlInput = typeof AgentControlInput.Type;

export const AgentControlResult = Schema.Struct({
  /** The agents the action changed. */
  threadIds: Schema.Array(ThreadId),
});
export type AgentControlResult = typeof AgentControlResult.Type;

export const AgentControlState = Schema.Struct({
  threadId: ThreadId,
  paused: Schema.Boolean,
  /** Agent messages and replies waiting for this agent. */
  queued: NonNegativeInt,
  /**
   * Present while a usage limit stopped this thread and the server has decided
   * what happens next: `resumeAt` when an automatic resume is scheduled, absent
   * when the user has to continue it. Clients notify from this, not from the
   * turn's failure.
   */
  usageResume: Schema.optional(Schema.Struct({ resumeAt: Schema.optional(IsoDateTime) })),
});
export type AgentControlState = typeof AgentControlState.Type;

export const AgentControlSubscribeInput = Schema.Struct({});
export type AgentControlSubscribeInput = typeof AgentControlSubscribeInput.Type;

/** Every agent that is paused, has queued messages or is stopped on a usage limit. Sent first, then after every change. */
export const AgentControlSnapshot = Schema.Array(AgentControlState);
export type AgentControlSnapshot = typeof AgentControlSnapshot.Type;

export class AgentControlError extends Schema.TaggedError<AgentControlError>()(
  "AgentControlError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Resume after a usage limit. The server records the schedule as a thread
 * activity of this kind (latest one wins); clients render it and offer Cancel
 * and Resume now.
 */
export const USAGE_RESUME_ACTIVITY_KIND = "viewcode.usage-resume";

export const UsageResumeState = Schema.Literals([
  /** A resume is scheduled for `resumeAt`. */
  "scheduled",
  /** The reset time is known, but automatic resume is off. */
  "reset-known",
  /** Out of usage and the reset time could not be determined. */
  "unknown",
  "cancelled",
  /** The scheduled resume ran. */
  "resumed",
  /** Resumed twice and still limited; nothing more is scheduled. */
  "gave-up",
]);
export type UsageResumeState = typeof UsageResumeState.Type;

export const UsageResumePayload = Schema.Struct({
  state: UsageResumeState,
  /** When the provider says the limit resets. */
  resetsAt: Schema.optional(IsoDateTime),
  /** When the resume turn starts (`resetsAt` plus a minute). */
  resumeAt: Schema.optional(IsoDateTime),
});
export type UsageResumePayload = typeof UsageResumePayload.Type;

export const UsageResumeInput = Schema.Struct({ threadId: ThreadId });
export type UsageResumeInput = typeof UsageResumeInput.Type;

export const UsageResumeResult = Schema.Struct({
  /** False when nothing was scheduled for the thread. */
  changed: Schema.Boolean,
});
export type UsageResumeResult = typeof UsageResumeResult.Type;
