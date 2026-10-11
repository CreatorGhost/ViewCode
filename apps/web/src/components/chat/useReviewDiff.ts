import type { FileDiffContentsLoader } from "@pierre/diffs";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  ReviewFindingsTarget,
} from "@t3tools/contracts";
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
  readonly pending: boolean;
  readonly error: string | null;
  /** Part of the change is not shown: a later page, a withheld hunk, or a patch too large. */
  readonly partial: boolean;
  /** Fills the hidden lines between hunks on request. */
  readonly loadDiffFiles: FileDiffContentsLoader | undefined;
}

const NO_FILES: ReadonlyArray<ReviewDiffFile> = [];

/**
 * The change a review looked at, as the diff viewer takes it: the pull request's diff as the
 * host has it now (its first page, as the pull request page loads it), or for a local review the
 * checkout's uncommitted changes, falling back to the branch's when there are none.
 */
export function useReviewDiff(input: {
  readonly environmentId: EnvironmentId;
  readonly target: ReviewFindingsTarget;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
}): ReviewDiff {
  const { environmentId, target, projectId, cwd } = input;
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
      ? reviewEnvironment.diffPreview({ environmentId, input: { cwd } })
      : null,
  );
  const localSource = useMemo(() => {
    const sources = localDiff.data?.sources ?? [];
    const workingTree = sources.find((source) => source.kind === "working-tree");
    return workingTree && workingTree.diff.trim().length > 0
      ? workingTree
      : (sources.find((source) => source.kind === "branch-range") ?? workingTree ?? null);
  }, [localDiff.data]);
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
