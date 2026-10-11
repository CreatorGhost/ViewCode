import type { FileDiffContentsLoader } from "@pierre/diffs";
import type {
  EnvironmentId,
  LocalReviewScope,
  ProjectId,
  PullRequestRef,
  ReviewPullRequestTarget,
} from "@t3tools/contracts";
import { localReviewDiffRequest } from "@t3tools/client-runtime/agent-review";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  createGitDiffFileContentsLoader,
  createPullRequestDiffFileContentsLoader,
} from "~/lib/diffFileContents";
import {
  buildFileDiffRenderKey,
  fnv1a32,
  getRenderablePatch,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";

import type { ReviewDiffFile } from "./reviewPanel.logic";

export interface ReviewDiff {
  readonly files: ReadonlyArray<ReviewDiffFile>;
  /** The base a local branch diff was read against, as the server resolved it. */
  readonly base: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  /** Part of the change is not shown: a later page, a withheld hunk, or a patch too large. */
  readonly partial: boolean;
  /** Fills the hidden lines between hunks on request. */
  readonly loadDiffFiles: FileDiffContentsLoader | undefined;
}

const NO_FILES: ReadonlyArray<ReviewDiffFile> = [];

/** What a review reads: a pull request, or the local changes of a checkout. */
export type ReviewDiffTarget =
  | Pick<ReviewPullRequestTarget, "kind" | "host" | "repository" | "number">
  | { readonly kind: "local" };

/**
 * The change a review looked at, as the diff viewer takes it: the pull request's diff as the
 * host has it now (its first page, as the pull request page loads it), or for a local review what
 * its scope read (`localReviewDiffRequest`): the branch against its base, one commit, or the
 * uncommitted changes; without a scope the uncommitted changes, falling back to the branch's.
 */
export function useReviewDiff(input: {
  readonly environmentId: EnvironmentId;
  readonly target: ReviewDiffTarget;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly scope?: LocalReviewScope | null;
}): ReviewDiff {
  const { environmentId, target, projectId, cwd } = input;
  const diffRequest = localReviewDiffRequest(input.scope ?? null);
  const { resolvedTheme } = useTheme();
  const reference = useMemo<PullRequestRef | null>(
    () =>
      target.kind === "pull-request" && projectId !== null
        ? {
            projectId,
            host: target.host,
            repository: target.repository,
            number: target.number,
          }
        : null,
    [projectId, target],
  );
  const pullRequestDiff = useEnvironmentQuery(
    reference === null ? null : pullRequestEnvironment.diff({ environmentId, input: reference }),
  );
  const localDiff = useEnvironmentQuery(
    target.kind === "local" && cwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: {
            cwd,
            ...(diffRequest.baseRef === undefined ? {} : { baseRef: diffRequest.baseRef }),
            ...(diffRequest.headRef === undefined ? {} : { headRef: diffRequest.headRef }),
          },
        })
      : null,
  );
  const sourceKind = diffRequest.source;
  const localSource = useMemo(() => {
    const sources = localDiff.data?.sources ?? [];
    const workingTree = sources.find((source) => source.kind === "working-tree");
    const branchRange = sources.find((source) => source.kind === "branch-range");
    if (sourceKind === "working-tree") return workingTree ?? null;
    if (sourceKind === "branch-range") return branchRange ?? null;
    return workingTree && workingTree.diff.trim().length > 0
      ? workingTree
      : (branchRange ?? workingTree ?? null);
  }, [localDiff.data, sourceKind]);
  const patch = reference !== null ? pullRequestDiff.data?.patch : localSource?.diff;

  const getPullRequestFile = useAtomCommand(pullRequestEnvironment.diffFileContents);
  const getLocalFile = useAtomCommand(reviewEnvironment.diffFileContents);
  const patchKey = patch === undefined ? "" : String(fnv1a32(patch));
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    if (reference !== null) {
      return createPullRequestDiffFileContentsLoader(getPullRequestFile, {
        environmentId,
        reference,
        commit: null,
        cacheKey: `review-panel:${environmentId}:${reference.repository}#${reference.number}:${patchKey}`,
      });
    }
    const preview = localDiff.data;
    if (preview === null || localSource === null) return undefined;
    return createGitDiffFileContentsLoader(getLocalFile, {
      environmentId,
      cwd: preview.cwd,
      sourceKind: localSource.kind,
      baseRef: localSource.baseRef,
      headRef: localSource.headRef,
      cacheKey: localSource.diffHash,
    });
  }, [
    environmentId,
    getLocalFile,
    getPullRequestFile,
    localDiff.data,
    localSource,
    patchKey,
    reference,
  ]);

  const parsed = useMemo(
    () =>
      getRenderablePatch(patch, `review-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: true,
      }),
    [patch, resolvedTheme],
  );
  const files = useMemo<ReadonlyArray<ReviewDiffFile>>(
    () =>
      parsed?.kind === "files"
        ? parsed.files.map((fileDiff) => ({
            fileKey: buildFileDiffRenderKey(fileDiff),
            path: resolveFileDiffPath(fileDiff),
            fileDiff,
          }))
        : NO_FILES,
    [parsed],
  );
  const query = reference !== null ? pullRequestDiff : localDiff;
  return {
    files,
    base: localSource?.kind === "branch-range" ? localSource.baseRef : null,
    pending: query.isPending && patch === undefined,
    error: query.error,
    partial:
      parsed?.kind === "raw" ||
      (reference !== null
        ? pullRequestDiff.data?.truncated === true || pullRequestDiff.data?.nextCursor != null
        : localSource?.truncated === true),
    loadDiffFiles,
  };
}
