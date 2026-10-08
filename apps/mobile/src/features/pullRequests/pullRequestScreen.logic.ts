import type {
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

type MergeOffer = Pick<PullRequestDetail, "mergeCapabilities"> & {
  readonly capabilities: Pick<PullRequestCapabilities, "actions" | "mergeMethods">;
};

export type PullRequestTone = "positive" | "warning" | "negative" | "neutral";

/** "18 of 19 passed · 1 running", counting skipped and neutral checks as passed. */
export function summarizePullRequestChecks(checks: ReadonlyArray<PullRequestCheck>): {
  readonly label: string;
  readonly tone: PullRequestTone;
} {
  if (checks.length === 0) return { label: "No checks", tone: "neutral" };
  let passed = 0;
  let failed = 0;
  let running = 0;
  for (const check of checks) {
    if (check.status === "pending" || check.status === "action-required") running++;
    else if (check.status === "failure" || check.status === "cancelled") failed++;
    else passed++;
  }
  const parts = [`${passed} of ${checks.length} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} running`);
  return {
    label: parts.join(" · "),
    tone: failed > 0 ? "negative" : running > 0 ? "warning" : "positive",
  };
}

export function summarizePullRequestMerge(
  detail: Pick<PullRequestDetail, "state" | "mergeability" | "baseComparison" | "behindBy">,
): { readonly label: string; readonly tone: PullRequestTone } {
  if (detail.state === "merged") return { label: "Merged", tone: "neutral" };
  if (detail.state === "closed") return { label: "Closed without merging", tone: "neutral" };
  if (detail.mergeability === "conflicting") return { label: "Has conflicts", tone: "negative" };
  if (detail.mergeability === "unknown")
    return { label: "Checking for conflicts", tone: "neutral" };
  if (detail.baseComparison === "behind" && detail.behindBy) {
    const commits = `${detail.behindBy} ${detail.behindBy === 1 ? "commit" : "commits"}`;
    return { label: `No conflicts · ${commits} behind`, tone: "positive" };
  }
  return { label: "No conflicts", tone: "positive" };
}

const MERGE_METHOD_ORDER: ReadonlyArray<PullRequestMergeMethod> = ["squash", "merge", "rebase"];

export const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
};

/** Methods both the host and the repository allow, squash first. */
export function availablePullRequestMergeMethods(
  detail: MergeOffer,
): ReadonlyArray<PullRequestMergeMethod> {
  return MERGE_METHOD_ORDER.filter(
    (method) =>
      detail.capabilities.mergeMethods.includes(method) && detail.mergeCapabilities[method],
  );
}

/** Merging is offered on an open, ready pull request the viewer may merge. */
export function canMergePullRequest(
  detail: MergeOffer &
    Pick<PullRequestDetail, "state" | "isDraft"> & {
      readonly viewerPermissions: Pick<PullRequestViewerPermissions, "actions">;
    },
): boolean {
  return (
    detail.state === "open" &&
    !detail.isDraft &&
    detail.capabilities.actions.includes("merge") &&
    detail.viewerPermissions.actions.includes("merge") &&
    availablePullRequestMergeMethods(detail).length > 0
  );
}
