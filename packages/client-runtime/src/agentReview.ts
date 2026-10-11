import {
  type AgentReviewMode,
  LocalReviewScope,
  type ReviewCommit,
  type ModelSelection,
  type ProjectId,
  type PullRequestRef,
  type PullRequestStartReviewInput,
  type ReviewBasedOnInput,
  type ReviewStartLocalInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ReviewProgress } from "./reviewFindings.ts";

/**
 * Starting an agent review and saying where it stands, the same way on every client: which RPC a
 * review goes to with what input, and the words its progress is told in.
 */

/**
 * What an agent review reads: a pull request, or the local changes of a thread's checkout
 * (servers advertising `localAgentReview`). Asked for from a chat (`sourceThreadId`), the reviewer
 * runs as that chat's child agent.
 */
export type AgentReviewRequest =
  | {
      readonly kind: "pull-request";
      readonly reference: PullRequestRef;
      readonly sourceThreadId?: ThreadId | undefined;
    }
  | { readonly kind: "local"; readonly projectId: ProjectId; readonly sourceThreadId: ThreadId };

/** How a review is asked for: how thorough, with which model, what to look at and read. */
export interface AgentReviewChoices {
  readonly mode: AgentReviewMode;
  readonly modelSelection: ModelSelection | null;
  readonly focus: string;
  /** Re-review only what changed since these findings. */
  readonly basedOn?: ReviewBasedOnInput | undefined;
  /** For local changes on servers advertising `localAgentReviewScope`: what to read. */
  readonly scope?: LocalReviewScope | null | undefined;
}

/**
 * Whether the start form offers "What to review": only for local changes, and only on servers
 * that read the choice (`localAgentReviewScope`). Elsewhere it is hidden rather than sent and
 * ignored, which would review something other than what the reader picked.
 */
export function canChooseLocalReviewScope(
  request: Pick<AgentReviewRequest, "kind">,
  capabilities: { readonly localAgentReviewScope?: boolean | undefined } | undefined,
): boolean {
  return request.kind === "local" && capabilities?.localAgentReviewScope === true;
}

export type AgentReviewStart =
  | { readonly method: "pullRequests.startReview"; readonly input: PullRequestStartReviewInput }
  | { readonly method: "review.startLocal"; readonly input: ReviewStartLocalInput };

/**
 * The request that starts a review: a pull request review or a review of local changes, with
 * only the choices that say something (an empty focus is none). A scope is sent only where the
 * server reads it (`canScope`): an older server would ignore it and review something else.
 */
export function buildAgentReviewStart(
  request: AgentReviewRequest,
  choices: AgentReviewChoices,
  options: { readonly canScope: boolean },
): AgentReviewStart {
  const focus = choices.focus.trim();
  const common = {
    mode: choices.mode,
    ...(choices.modelSelection ? { modelSelection: choices.modelSelection } : {}),
    ...(focus ? { focus } : {}),
    ...(choices.basedOn ? { incremental: true, basedOn: choices.basedOn } : {}),
    ...(request.sourceThreadId ? { sourceThreadId: request.sourceThreadId } : {}),
  };
  if (request.kind === "pull-request") {
    return { method: "pullRequests.startReview", input: { ...request.reference, ...common } };
  }
  return {
    method: "review.startLocal",
    input: {
      projectId: request.projectId,
      ...common,
      ...(options.canScope && choices.scope ? { scope: choices.scope } : {}),
    },
  };
}

/** How long a review has run, to the minute: "just started", "6 min", "1 h 5 min". */
export function formatReviewElapsed(durationMs: number): string {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

const MAX_ERROR_CHARS = 140;

/** A provider's error cut to its first line, short enough for one status line. */
export function shortReviewError(error: string | null): string {
  const line =
    error
      ?.split("\n")
      .find((part) => part.trim().length > 0)
      ?.trim() ?? "";
  if (line.length === 0) return "the reviewer stopped with an error";
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1).trimEnd()}…` : line;
}

/**
 * The one line that says where a review stands, or null once it is done: "Reviewing… Deep
 * review · GPT-6.1 · 6 min", "Review failed: <error>", "The review ended without sending
 * findings". `newer` is a review whose findings are not the ones shown below it.
 */
export function reviewStatusText(input: {
  readonly progress: ReviewProgress;
  /** "Deep review · GPT-6.1". */
  readonly label: string;
  readonly elapsedMs: number;
  readonly newer: boolean;
}): string | null {
  const { progress, label, newer } = input;
  switch (progress.kind) {
    case "done":
      return null;
    case "running":
      return `${newer ? "A new review is running:" : "Reviewing…"} ${label} · ${formatReviewElapsed(input.elapsedMs)}`;
    case "failed":
      return `${newer ? "A new review failed" : "Review failed"}: ${shortReviewError(progress.error)}`;
    case "ended":
      return progress.partial
        ? "The review ended before sending all its findings"
        : `${newer ? "A new review" : "The review"} ended without sending findings`;
  }
}

/** What a review of local changes reads, in a few words: "Branch vs origin/main". */
export function localReviewScopeLabel(scope: LocalReviewScope | null | undefined): string {
  switch (scope?.kind) {
    case undefined:
      return "Uncommitted changes, else the branch";
    case "uncommitted":
      return "Uncommitted changes";
    case "branch":
      return scope.base === undefined ? "Branch vs its base" : `Branch vs ${scope.base}`;
    case "commit":
      return `Commit ${scope.sha.slice(0, 7)}`;
  }
}

/**
 * What a review's change view shows, as its header names it: "PR #12", "Branch vs origin/main",
 * "Commit 7523ce0", "Uncommitted changes", or "Local changes" for a review that left it to the
 * reviewer. `shownBase` is the base the diff was read against, for a branch review that named none.
 */
export function reviewedChangeLabel(
  target: { readonly kind: "pull-request"; readonly number: number } | { readonly kind: "local" },
  scope: LocalReviewScope | null,
  shownBase: string | null,
): string {
  if (target.kind === "pull-request") return `PR #${target.number}`;
  if (scope === null) return "Local changes";
  if (scope.kind === "branch" && scope.base === undefined && shownBase !== null) {
    return localReviewScopeLabel({ kind: "branch", base: shownBase });
  }
  return localReviewScopeLabel(scope);
}

/**
 * What to read for a review of local changes, as `review.getDiffPreview` takes it, and which of
 * its sources is the reviewed change: the branch range for a branch (against its named base) or a
 * commit (`<sha>^...<sha>`), the working tree for uncommitted changes, and for a review that left it
 * to the reviewer the working tree, else the branch.
 */
export function localReviewDiffRequest(scope: LocalReviewScope | null): {
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly source: "working-tree" | "branch-range" | "auto";
} {
  switch (scope?.kind) {
    case undefined:
      return { source: "auto" };
    case "uncommitted":
      return { source: "working-tree" };
    case "branch":
      return scope.base === undefined
        ? { source: "branch-range" }
        : { baseRef: scope.base, source: "branch-range" };
    case "commit":
      return { baseRef: `${scope.sha}^`, headRef: scope.sha, source: "branch-range" };
  }
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** A commit named by a pasted SHA, when the text is one (7 to 64 hex digits). */
export function pastedReviewCommitSha(text: string): string | null {
  const trimmed = text.trim();
  return COMMIT_SHA.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * The commits a picker shows for what the reader typed: those whose SHA starts with it, or whose
 * subject or author contains it, in the order listed (newest first).
 */
export function filterReviewCommits(
  commits: ReadonlyArray<ReviewCommit>,
  query: string,
): ReadonlyArray<ReviewCommit> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commits;
  return commits.filter(
    (commit) =>
      commit.sha.toLowerCase().startsWith(needle) ||
      commit.subject.toLowerCase().includes(needle) ||
      commit.author.toLowerCase().includes(needle),
  );
}

const isLocalReviewScope = Schema.is(LocalReviewScope);

/** Whether a scope the reader is still filling in can be sent: a base that is a ref, a SHA. */
export function localReviewScopeReady(scope: LocalReviewScope | null): boolean {
  return scope === null || isLocalReviewScope(scope);
}
