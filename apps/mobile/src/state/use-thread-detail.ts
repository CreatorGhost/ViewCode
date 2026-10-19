import { useAtomValue } from "@effect/atom-react";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentThread } from "@t3tools/client-runtime/viewcodeThread";
import { Atom } from "effect/reactivity";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { environmentThreadDetails, useEnvironmentThread } from "./threads";
import { useThreadSelection } from "./use-thread-selection";

export interface ThreadDetailTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

export function useThreadDetail(target: ThreadDetailTarget) {
  return useEnvironmentThread(target.environmentId, target.threadId);
}

/**
 * The selection owns the subscription so it can hold it back while a queued
 * creation has not reached the server yet.
 */
export function useSelectedThreadDetailState() {
  return useThreadSelection().selectedThreadDetailState;
}

export function useSelectedThreadDetail() {
  return Option.getOrNull(useSelectedThreadDetailState().data);
}

const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null);

export function useThreadProjection(target: ThreadDetailTarget) {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? EMPTY_THREAD_PROJECTION_ATOM
      : environmentThreadDetails.threadAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}

export function useSelectedThreadProjection() {
  const { selectedThreadRef, selectedThreadCreation } = useThreadSelection();
  const ref = selectedThreadCreation === null ? selectedThreadRef : null;
  return useThreadProjection({
    environmentId: ref?.environmentId ?? null,
    threadId: ref?.threadId ?? null,
  });
}

const EMPTY_PENDING_REQUESTS_ATOM = Atom.make<PendingThreadRequests | null>(null);

export function useSelectedThreadPendingRequests() {
  const { selectedThread, selectedThreadCreation } = useThreadSelection();
  return useAtomValue(
    selectedThread === null || selectedThreadCreation !== null
      ? EMPTY_PENDING_REQUESTS_ATOM
      : environmentThreadDetails.pendingRequestsAtom({
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
        }),
  );
}
