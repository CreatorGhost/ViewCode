import {
  type ReviewDiffPreviewInput,
  VcsUnsupportedOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { request } from "../rpc/client.ts";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const patchReads = Semaphore.makeUnsafe(4);
  const diffFileScheduler = createAtomCommandScheduler();
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    /** A checkout's latest commits, to pick one to review; servers with `localAgentReviewScope`. */
    commits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:commits",
      tag: WS_METHODS.reviewListCommits,
      staleTimeMs: 30_000,
    }),
    diffFilePatch: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-file-patch",
      staleTimeMs: 5 * 60_000,
      execute: (input: {
        request: ReviewDiffPreviewInput & { file: NonNullable<ReviewDiffPreviewInput["file"]> };
        cacheKey: string;
      }) =>
        request(WS_METHODS.reviewGetDiffPreview, input.request).pipe(
          patchReads.withPermit,
          Effect.flatMap((result) => {
            const source = result.sources.find(
              (source) => source.kind === input.request.file.sourceKind,
            );
            return source
              ? Effect.succeed(source)
              : Effect.fail(
                  new VcsUnsupportedOperationError({
                    operation: "review.diffFilePatch",
                    kind: "git",
                    detail: "Diff no longer available. Refresh the comparison.",
                  }),
                );
          }),
        ),
    }),
    /**
     * An agent review of a thread's checkout (or the project's workspace) in a new thread on the
     * same checkout. Only for environments advertising `localAgentReview`.
     */
    startLocal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:start-local",
      tag: WS_METHODS.reviewStartLocal,
    }),
    /** A new session that fixes review findings, on the environment that holds the review. */
    startFixThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:start-fix-thread",
      tag: WS_METHODS.reviewStartFixThread,
    }),
    /** Reverts a fix session to before its fix; servers advertising `reviewFixUndo`. */
    undoFixes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:undo-fixes",
      tag: WS_METHODS.reviewUndoFixes,
    }),
    /** Posts findings to the reviewed pull request as one review. */
    postFindings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:post-findings",
      tag: WS_METHODS.reviewPostFindings,
    }),
    /** Rates one finding up or down, or takes it back; servers advertising `reviewFindingRatings`. */
    rateFinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:rate-finding",
      tag: WS_METHODS.reviewRateFinding,
    }),
    /** What was learned of an account's review writing; servers advertising `learnedReviewStyle`. */
    learnedStyle: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:learned-style",
      tag: WS_METHODS.reviewGetLearnedStyle,
      staleTimeMs: 60_000,
    }),
    learnStyle: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:learn-style",
      tag: WS_METHODS.reviewLearnStyle,
    }),
    forgetLearnedStyle: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:forget-learned-style",
      tag: WS_METHODS.reviewForgetLearnedStyle,
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:diff-file-contents",
      tag: WS_METHODS.reviewGetDiffFileContents,
      scheduler: diffFileScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.cwd,
            input.sourceKind,
            input.baseRef,
            input.headRef,
            input.oldPath,
            input.newPath,
            input.changeType,
          ]),
      },
    }),
  };
}
