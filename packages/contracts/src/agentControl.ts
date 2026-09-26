import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

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
});
export type AgentControlState = typeof AgentControlState.Type;

export const AgentControlSubscribeInput = Schema.Struct({});
export type AgentControlSubscribeInput = typeof AgentControlSubscribeInput.Type;

/** Every agent that is paused or has queued messages. Sent first, then after every change. */
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
