import type { OrchestrationThreadShell, ReviewFindingsTarget, ThreadId } from "@t3tools/contracts";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

type CandidateThread = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "branch" | "worktreePath" | "pullRequests" | "archivedAt" | "updatedAt"
>;

/**
 * The sessions already working on what a review looked at, most recently active first: threads
 * linked to the reviewed pull request, or for a local review the threads on the review's own
 * checkout. The review thread is never one of them: reviewers do not fix. With exactly one, it is
 * the obvious choice and comes preselected.
 */
export function reviewFixCandidates<T extends CandidateThread>(input: {
  readonly reviewThread: Pick<CandidateThread, "id" | "projectId" | "branch" | "worktreePath">;
  readonly target: ReviewFindingsTarget;
  readonly threads: ReadonlyArray<T>;
}): { readonly candidates: ReadonlyArray<T>; readonly preselectedId: ThreadId | null } {
  const { reviewThread, target } = input;
  const candidates = input.threads
    .filter((thread) => {
      if (thread.id === reviewThread.id || thread.archivedAt !== null) return false;
      if (target.kind === "pull-request") {
        return visibleThreadPullRequests(thread.pullRequests).some((link) =>
          threadPullRequestKeysEqual(link, target),
        );
      }
      return (
        thread.projectId === reviewThread.projectId &&
        thread.branch === reviewThread.branch &&
        thread.worktreePath === reviewThread.worktreePath
      );
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { candidates, preselectedId: candidates.length === 1 ? candidates[0]!.id : null };
}
