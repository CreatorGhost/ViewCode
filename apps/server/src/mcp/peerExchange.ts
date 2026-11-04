import { parseAgentMessage } from "@t3tools/shared/agentMessages";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Messaging between chats the user started separately.
 *
 * A parent and its subagents (and forks, which keep the root) are one agent tree: they message
 * freely, since the user authorised that delegation. Two top-level chats are independent. One
 * may ask the other something only with its user's Send, and the other may answer it once,
 * without asking. Anything further is a new request and asks again, so acknowledgements, thanks
 * and status chatter cannot loop. A chat that launched another (`create_threads`,
 * `t3_thread_launch`, at its user's request) stays connected to it. See docs/internals/viewcode.md
 * "Agent-to-agent messaging".
 */

interface ChatIdentity {
  readonly id: ThreadId;
  readonly kind?: string | null | undefined;
  readonly lineage: { readonly rootThreadId: ThreadId };
}

/**
 * Whether `caller` reaching `target` crosses from one agent tree into another. RockBot (the
 * user's own orchestrator) is not a peer: its writes already wait for its user.
 */
export function isIndependentChat(caller: ChatIdentity, target: ChatIdentity): boolean {
  return (
    caller.kind !== "orchestrator" &&
    caller.id !== target.id &&
    caller.lineage.rootThreadId !== target.lineage.rootThreadId
  );
}

export interface PeerMessage {
  readonly id: string;
  /** Who sent it: this chat ("caller") or the other one ("target"). */
  readonly from: "caller" | "target";
  readonly createdAtMs: number;
  readonly text: string;
}

/**
 * What a new message from the caller to the target would be. A "reply" needs no approval: the
 * target's last message asked something (its user approved that) and the caller has not
 * answered yet. Anything else is a "request", which its user must approve. An earlier message
 * with the same text that the target has not answered is a "duplicate".
 */
export function peerExchangeStep(
  messages: ReadonlyArray<PeerMessage>,
  text: string,
):
  | { readonly kind: "request" }
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "reply";
      /** The request being answered: its envelope id, or its message id for a plain message. */
      readonly inReplyTo: string;
    } {
  const last = messages.toSorted((left, right) => left.createdAtMs - right.createdAtMs).at(-1);
  if (last === undefined) return { kind: "request" };
  const envelope = parseAgentMessage(last.text);
  if (last.from === "target") {
    return envelope?.inReplyTo != null
      ? { kind: "request" }
      : { kind: "reply", inReplyTo: envelope?.messageId ?? last.id };
  }
  return (envelope?.body ?? last.text).trim() === text.trim()
    ? { kind: "duplicate" }
    : { kind: "request" };
}

/**
 * `isIndependentChat`, unless one tree launched the other: an agent created the launched tree's
 * root, and its opening message names the launching chat (or that chat's root) as sender, so
 * forks and subagents of a chat this agent launched stay connected. An agent-made chat with no
 * messages yet has nothing of anyone's in it. Reads records only when the trees differ.
 */
export const isSeparateChat = (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadRecords">,
  caller: ChatIdentity,
  target: ChatIdentity & { readonly createdBy: string },
) =>
  Effect.gen(function* () {
    if (!isIndependentChat(caller, target)) return false;
    /** Who sent an agent-made chat's opening message: null for none, undefined when not agent-made. */
    const launcher = (threadId: ThreadId) =>
      threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }).pipe(
        Effect.map((records) => {
          if (records.thread.createdBy !== "agent") return undefined;
          const first = records.messages.toSorted(
            (left, right) =>
              DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
          )[0];
          return first === undefined ? null : first.senderThreadId;
        }),
      );
    const callerRoot = caller.lineage.rootThreadId;
    const targetRoot = target.lineage.rootThreadId;
    const [targetLauncher, callerLauncher] = yield* Effect.all([
      launcher(targetRoot),
      launcher(callerRoot),
    ]);
    if (targetLauncher === caller.id || targetLauncher === callerRoot) return false;
    if (callerLauncher === target.id || callerLauncher === targetRoot) return false;
    if (target.createdBy === "agent") {
      const own = target.id === targetRoot ? targetLauncher : yield* launcher(target.id);
      if (own === null) return false;
    }
    return true;
  });
