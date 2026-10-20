import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";

/** The first preferred method the repository allows, else the host's first allowed one. */
export function preferredPullRequestMergeMethod(
  allowed: ReadonlyArray<PullRequestMergeMethod>,
  preferred: ReadonlyArray<PullRequestMergeMethod | null | undefined>,
): PullRequestMergeMethod {
  for (const method of preferred) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? "merge";
}

/**
 * The merge method for a one-tap merge, picked on the fresh detail the server reads at merge time.
 * Without it a merge asks for a merge commit, which a repository that allows only squash or
 * rebase refuses.
 */
export function resolvePullRequestDetailMergeMethod(
  detail: {
    readonly capabilities: Pick<PullRequestDetail["capabilities"], "mergeMethods">;
    readonly mergeCapabilities: PullRequestDetail["mergeCapabilities"];
  },
  preferred: ReadonlyArray<PullRequestMergeMethod | null | undefined>,
): PullRequestMergeMethod {
  const allowed = detail.capabilities.mergeMethods.filter(
    (method) => detail.mergeCapabilities[method],
  );
  if (allowed.length === 0) throw new Error("No merge method is available for this repository.");
  return preferredPullRequestMergeMethod(allowed, preferred);
}
