import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PullRequestRef } from "./pullRequest.ts";
import {
  AgentReviewMode,
  LocalReviewScope,
  ReviewBasedOnInput,
  ReviewFindingsMode,
} from "./reviewFindings.ts";

export const AGENT_REVIEW_MODES: ReadonlyArray<{
  readonly mode: AgentReviewMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "quick",
    label: "Quick review",
    description: "One agent reads the change in a single pass.",
  },
  {
    mode: "deep",
    label: "Deep review",
    description:
      "Several agents review through different lenses and try to disprove each other's findings. Uses more of your plan.",
  },
  {
    mode: "security",
    label: "Security audit",
    description:
      "Several agents hunt for vulnerabilities in the change and the code it reaches. Uses more of your plan.",
  },
];

/**
 * Starts an agent review of a pull request: a new thread on the reference's project, linked to
 * the pull request, whose first message asks for the review. Lives here rather than beside
 * `PullRequestRef` because it carries a model selection.
 */
export const PullRequestStartReviewInput = Schema.Struct({
  ...PullRequestRef.fields,
  /** Absent: a quick review. */
  mode: Schema.optional(AgentReviewMode),
  /** Absent: the project's default model for new threads. */
  modelSelection: Schema.optional(ModelSelection),
  /** What to look at most closely, for example "security"; appended to the review request. */
  focus: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  /**
   * What the findings are for. Absent: "comment" on somebody else's pull request, "fix" on the
   * reader's own.
   */
  findingsMode: Schema.optional(ReviewFindingsMode),
  /**
   * Re-review only what changed since the findings in `basedOn` and check those again. Falls back
   * to a full review when either commit is unknown. Only for servers advertising
   * `incrementalAgentReview`.
   */
  incremental: Schema.optional(Schema.Boolean),
  basedOn: Schema.optional(ReviewBasedOnInput),
  /**
   * The chat the review is asked for from, which the reviewer runs as a child agent of. Absent
   * (the pull request page): a thread of its own. Older servers ignore it.
   */
  sourceThreadId: Schema.optional(ThreadId),
});
export type PullRequestStartReviewInput = typeof PullRequestStartReviewInput.Type;

/**
 * Starts an agent review of a checkout's own changes (uncommitted, or the branch when there are
 * none) in a new thread on the source thread's branch and worktree, or on the project's workspace
 * without one. Only send to environments advertising `localAgentReview`.
 */
export const ReviewStartLocalInput = Schema.Struct({
  projectId: ProjectId,
  /**
   * The thread whose checkout to review, which the reviewer runs as a child agent of. Absent: the
   * project's workspace, in a thread of its own.
   */
  sourceThreadId: Schema.optional(ThreadId),
  /** Absent: a quick review. */
  mode: Schema.optional(AgentReviewMode),
  /** Absent: the project's default model for new threads. */
  modelSelection: Schema.optional(ModelSelection),
  focus: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  /** Review again with the findings in `basedOn` checked; see `PullRequestStartReviewInput`. */
  incremental: Schema.optional(Schema.Boolean),
  basedOn: Schema.optional(ReviewBasedOnInput),
  /** What to read; see `LocalReviewScope`. */
  scope: Schema.optional(LocalReviewScope),
});
export type ReviewStartLocalInput = typeof ReviewStartLocalInput.Type;

export const PullRequestStartReviewResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type PullRequestStartReviewResult = typeof PullRequestStartReviewResult.Type;
