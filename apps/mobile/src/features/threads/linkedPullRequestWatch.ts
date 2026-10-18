import type { EnvironmentThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import type { OrchestrationV2AppThreadLineage } from "@t3tools/contracts";

type WatchThread = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "settledAt" | "settledOverride" | "parentThreadId" | "kind"
> & {
  readonly source?: {
    readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent">;
  };
};

export function canStartLinkedPullRequestWatch(thread: WatchThread | null, permitted: boolean) {
  if (!permitted || thread === null) return false;
  // Native lineage wins. Detail-only legacy imports may still have only the compatibility alias.
  const subagent = thread.source
    ? thread.source.lineage.relationshipToParent === "subagent"
    : thread.parentThreadId != null && thread.kind !== "sidechat";
  return (
    thread.archivedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    !subagent
  );
}
