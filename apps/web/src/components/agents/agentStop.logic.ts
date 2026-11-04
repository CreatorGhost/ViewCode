import { collectAgentTree } from "@t3tools/client-runtime/state/child-agents";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** An explicit null is a draft pane, which must never inherit the focused route's tree. */
export function agentStopState<
  T extends Parameters<typeof collectAgentTree>[0][number] & { readonly kind?: string | null },
>(
  threads: ReadonlyArray<T>,
  threadRef: ScopedThreadRef | null | undefined,
  routeThreadRef: ScopedThreadRef | null,
) {
  const ref = threadRef === undefined ? routeThreadRef : threadRef;
  const isSidechat =
    ref !== null &&
    threads.some(
      (thread) =>
        thread.environmentId === ref.environmentId &&
        thread.id === ref.threadId &&
        thread.kind === "sidechat",
    );
  return {
    ref,
    othersRunning:
      ref === null || isSidechat
        ? []
        : collectAgentTree(threads, ref).filter(
            (entry) => entry.running && entry.thread.id !== ref.threadId,
          ),
  };
}
