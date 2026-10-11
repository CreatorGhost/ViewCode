import type {
  AgentReviewMode,
  LocalReviewScope,
  ModelSelection,
  ProjectId,
  PullRequestRef,
  PullRequestStartReviewInput,
  ReviewBasedOnInput,
  ReviewStartLocalInput,
  ThreadId,
} from "@t3tools/contracts";

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
