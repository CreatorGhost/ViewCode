import { useAtomValue } from "@effect/atom-react";
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";

const EMPTY_QUEUE_WORKFLOW_ATOM = Atom.make<ThreadQueueWorkflowState | null>(null);

export function useThreadQueueWorkflow(target: ScopedThreadRef | null) {
  return useAtomValue(
    target === null
      ? EMPTY_QUEUE_WORKFLOW_ATOM
      : environmentThreadDetails.queueWorkflowAtom(target),
  );
}

/** A server echo may arrive before the originating device finishes durable outbox cleanup. */
export function countThreadQueuedMessages(input: {
  readonly serverQueue: ReadonlyArray<{ readonly messageId: string }>;
  readonly localMessages: ReadonlyArray<{ readonly messageId: string }>;
  readonly serverMessages: ReadonlyArray<{ readonly id: string }>;
}): number {
  const accepted = new Set(input.serverMessages.map((message) => message.id));
  const queued = new Set(input.serverQueue.map((entry) => entry.messageId));
  for (const message of input.localMessages) {
    if (!accepted.has(message.messageId)) queued.add(message.messageId);
  }
  return queued.size;
}
