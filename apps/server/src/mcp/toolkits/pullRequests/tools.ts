import {
  AgentReviewMode,
  McpCapabilityUnavailableError,
  PositiveInt,
  PullRequestOperationError,
  PullRequestReviewVerdict,
  PullRequestUnavailableError,
  PullRequestState,
  ReviewFindingKey,
  ReviewFindingSeverity,
  ReviewFindingsMode,
  ReviewFindingsReport,
  ReviewPostFindingsError,
  REVIEW_POST_MAX_OVERALL_COMMENT_CHARS,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PullRequestAgentReview from "../../../pullRequest/PullRequestAgentReview.ts";
import { SUBMIT_REVIEW_FINDINGS_TOOL } from "../../../review/ReviewPlaybook.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TurnOrigin from "../../../orchestration/TurnOrigin.ts";
import * as ReviewFindingsPoster from "../../../review/ReviewFindingsPoster.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  PullRequestAgentReview.PullRequestAgentReview,
  ReviewFindingsPoster.ReviewFindingsPoster,
  TurnOrigin.TurnOrigin,
];

const REGISTER_EVERY_PR =
  "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

/**
 * Either the pull request's URL or its repository and number. Both forms
 * resolve to the same host-level identity, so the agent can pass whichever
 * the host CLI handed back.
 */
export const PullRequestTargetInput = Schema.Struct({
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The pull request's web URL, for example https://github.com/owner/repo/pull/123. Preferred when you have it; host, repository and number are read from it.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository path below the host, for example owner/repo. Required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Pull request number. Required with repository when url is omitted.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Host the repository lives on, for example github.com. Defaults to the host of this thread's project.",
    }),
  ),
});
export type PullRequestTargetInput = typeof PullRequestTargetInput.Type;

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestThreadNotFoundError extends Schema.TaggedError<PullRequestThreadNotFoundError>()(
  "PullRequestThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestLinkFailedError extends Schema.TaggedError<PullRequestLinkFailedError>()(
  "PullRequestLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedError<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotWatchableError extends Schema.TaggedError<PullRequestNotWatchableError>()(
  "PullRequestNotWatchableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Cannot watch this pull request: ${this.reason}.`;
  }
}

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export class PullRequestReviewFailedError extends Schema.TaggedError<PullRequestReviewFailedError>()(
  "PullRequestReviewFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not start the review.";
  }
}

export class ReviewFindingsFailedError extends Schema.TaggedError<ReviewFindingsFailedError>()(
  "ReviewFindingsFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not record the review findings.";
  }
}

export class ReviewFindingsTargetMissingError extends Schema.TaggedError<ReviewFindingsTargetMissingError>()(
  "ReviewFindingsTargetMissingError",
  {},
) {
  override get message(): string {
    return "This thread has no linked pull request. Pass target local for a review of local changes.";
  }
}

export class ReviewPostFailedError extends Schema.TaggedError<ReviewPostFailedError>()(
  "ReviewPostFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the review findings to post.";
  }
}

/** Posting is something the user asks for, never something an agent decides. */
export class ReviewPostNotRequestedError extends Schema.TaggedError<ReviewPostNotRequestedError>()(
  "ReviewPostNotRequestedError",
  {},
) {
  override get message(): string {
    return "Posting needs the user's explicit request in this chat or a click in the Review panel. This turn was not started by the user's own message, so nothing was posted.";
  }
}

export class ReviewPostNothingError extends Schema.TaggedError<ReviewPostNothingError>()(
  "ReviewPostNothingError",
  {
    reason: Schema.Literals([
      "no-findings",
      "local",
      "unknown-key",
      "none-selected",
      "already-posted",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-findings":
        return "No review findings were found on this thread or on a thread linked to its pull request.";
      case "local":
        return "These findings are about local changes, so there is no pull request to post them to.";
      case "unknown-key":
        return "Some keys do not name a finding of this review. Keys are finding:<index> and check:<index>, counted from 0.";
      case "none-selected":
        return "No finding matches what was asked for.";
      case "already-posted":
        return "Every finding asked for was already posted.";
    }
  }
}

export const PullRequestToolError = Schema.Union([
  McpCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchFailedError,
  PullRequestNotWatchableError,
  PullRequestReviewFailedError,
  ReviewFindingsFailedError,
  ReviewFindingsTargetMissingError,
  ReviewPostFailedError,
  ReviewPostNotRequestedError,
  ReviewPostNothingError,
  // The review service's own failures say what to change (pick a model, sign in to the host).
  PullRequestAgentReview.PullRequestAgentReviewError,
  ReviewPostFindingsError,
  PullRequestUnavailableError,
  PullRequestOperationError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the pull request was linked to this thread before the call.",
  }),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the pull request was not linked to this thread to begin with.",
  }),
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const WatchPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  watching: Schema.Boolean.annotate({
    description: "Whether ViewCode now watches the pull request for this thread.",
  }),
  wasWatching: Schema.Boolean.annotate({
    description: "Whether it was already watched before the call.",
  }),
});
export type WatchPullRequestResult = typeof WatchPullRequestResult.Type;

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
  watching: Schema.Boolean,
  state: Schema.NullOr(PullRequestState),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
  stack: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** 1-based, bottom of the stack first. */
      position: Schema.Int,
      size: Schema.Int,
    }),
  ),
});
export type ThreadPullRequestEntry = typeof ThreadPullRequestEntry.Type;

export const ListThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestEntry),
  chains: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** Bottom to top. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;

export const ReviewPullRequestInput = Schema.Struct({
  ...PullRequestTargetInput.fields,
  mode: Schema.optional(
    AgentReviewMode.annotate({
      description:
        "quick (default): one agent, one pass. deep: several agents review through different lenses and try to disprove each other's findings. security: a security audit of the change and the code it reaches. deep and security use more of the user's plan.",
    }),
  ),
  focus: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
      description: 'What the reviewer should look at most closely, for example "error handling".',
    }),
  ),
  findingsMode: Schema.optional(
    ReviewFindingsMode.annotate({
      description:
        "What the user does with the findings: fix them, or post them to the pull request as review comments. Defaults to comment when the pull request is somebody else's and fix when it is the user's own; pass it only when the user asked for the other.",
    }),
  ),
});
export type ReviewPullRequestInput = typeof ReviewPullRequestInput.Type;

export const ReviewLocalChangesInput = Schema.Struct({
  mode: ReviewPullRequestInput.fields.mode,
  focus: ReviewPullRequestInput.fields.focus,
});
export type ReviewLocalChangesInput = typeof ReviewLocalChangesInput.Type;

export const ReviewLocalChangesResult = Schema.Struct({
  threadId: Schema.String.annotate({ description: "The new review thread." }),
  title: Schema.String,
});
export type ReviewLocalChangesResult = typeof ReviewLocalChangesResult.Type;

export const ReviewPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  threadId: Schema.String.annotate({ description: "The new review thread." }),
  title: Schema.String,
});
export type ReviewPullRequestResult = typeof ReviewPullRequestResult.Type;

export const SubmitReviewFindingsInput = Schema.Struct({
  ...ReviewFindingsReport.fields,
  target: Schema.optional(
    Schema.Literals(["pull-request", "local"]).annotate({
      description:
        "What you reviewed. Defaults to the pull request linked to this thread, or local when none is linked.",
    }),
  ),
  mode: Schema.optional(
    ReviewFindingsMode.annotate({
      description:
        "Pass only when the review request names one. Otherwise ViewCode decides: review comments for somebody else's pull request, fixes for the user's own or for local changes.",
    }),
  ),
});
export type SubmitReviewFindingsInput = typeof SubmitReviewFindingsInput.Type;

export const SubmitReviewFindingsResult = Schema.Struct({
  target: Schema.Literals(["pull-request", "local"]),
  findings: Schema.Int,
  needsChecking: Schema.Int,
  message: Schema.String,
});
export type SubmitReviewFindingsResult = typeof SubmitReviewFindingsResult.Type;

export const PostReviewFindingsInput = Schema.Struct({
  findingsActivityId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The findings to post from. Defaults to the latest review findings on this thread, or on a thread linked to the same pull request.",
    }),
  ),
  keys: Schema.optional(
    Schema.Array(ReviewFindingKey).check(Schema.isMinLength(1)).annotate({
      description:
        'Exactly which findings to post: "finding:<index>" in findings, "check:<index>" in needsChecking, counted from 0. Omit to post the reported findings, all of them or those of the severities given.',
    }),
  ),
  severities: Schema.optional(
    Schema.Array(ReviewFindingSeverity).check(Schema.isMinLength(1)).annotate({
      description:
        'Post only the reported findings of these severities, for example ["blocker"] for "post the blockers". Ignored with keys.',
    }),
  ),
  verdict: Schema.optional(
    PullRequestReviewVerdict.annotate({
      description:
        "comment (default). approve or request-changes only when the user said so in their latest message.",
    }),
  ),
  overallComment: Schema.optional(
    Schema.String.check(Schema.isMaxLength(REVIEW_POST_MAX_OVERALL_COMMENT_CHARS)).annotate({
      description: "The review's own text above the findings. Only words the user asked for.",
    }),
  ),
});
export type PostReviewFindingsInput = typeof PostReviewFindingsInput.Type;

export const PostReviewFindingsResult = Schema.Struct({
  url: Schema.String.annotate({ description: "The pull request the review was posted on." }),
  posted: Schema.Int,
  inline: Schema.Int.annotate({ description: "Posted on their line of the diff." }),
  inText: Schema.Int.annotate({
    description: "Posted in the review's text because the diff does not show their line.",
  }),
  alreadyPosted: Schema.Int.annotate({
    description: "Asked for but posted before, so left out.",
  }),
  headMoved: Schema.Boolean.annotate({
    description:
      "The pull request has commits the review did not read; the comments sit on the reviewed commit.",
  }),
});
export type PostReviewFindingsResult = typeof PostReviewFindingsResult.Type;

const LinkPullRequestTool = Tool.make("link_pull_request", {
  description: `${REGISTER_EVERY_PR} Links a pull request to this thread so ViewCode tracks it, shows its status beside the thread, and settles the thread when it merges. Pass the URL, or repository plus number. Linking an already-linked pull request succeeds with alreadyLinked=true.`,
  parameters: PullRequestTargetInput,
  success: LinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link pull request to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Remove a pull request link from this thread, for example after closing a pull request you opened by mistake. Pass the URL, or repository plus number. Unlinking a pull request that is not linked succeeds with wasLinked=false.",
  parameters: PullRequestTargetInput,
  success: UnlinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull request from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description: `List the pull requests linked to this thread with their last known host state, whether ViewCode watches each one, and how they chain into stacks (bottom to top). ${REGISTER_EVERY_PR}`,
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WatchPullRequestTool = Tool.make("watch_pull_request", {
  description:
    "Have ViewCode watch an open pull request for this thread, linking it first if needed. ViewCode checks it every two minutes and wakes you with a message when a check fails, all checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor or babysit a pull request instead of polling, sleeping, or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: check readiness yourself before merging. Watching ends when the pull request merges or closes, when ViewCode cannot read it 8 times in a row, after 10 comment-only wakes in a row, when the thread settles or is archived, or when you call unwatch_pull_request.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnwatchPullRequestTool = Tool.make("unwatch_pull_request", {
  description:
    "Stop ViewCode from watching a pull request for this thread. The pull request stays linked. Pass the URL, or repository plus number.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReviewPullRequestTool = Tool.make("review_pull_request", {
  description:
    "Start an agent review of a pull request in a new ViewCode thread on this thread's project, linked to the pull request, for the user to read and continue. The reviewer follows ViewCode's review playbook for the chosen mode, changes no files and posts nothing to the host. It runs with the user's default model for new threads in the project, or this thread's model when none is set. The call returns once the review has started; it does not wait for or return the findings. Pass the URL, or repository plus number.",
  parameters: ReviewPullRequestInput,
  success: ReviewPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a pull request review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReviewLocalChangesTool = Tool.make("review_local_changes", {
  description:
    "Start an agent review of this thread's local changes in a new ViewCode thread on the same branch and checkout, for the user to read and continue: the uncommitted changes, or the branch against its base when there are none. The reviewer follows ViewCode's review playbook for the chosen mode and changes no files. It runs with the user's default model for new threads in the project, or this thread's model when none is set. The call returns once the review has started; it does not wait for or return the findings.",
  parameters: ReviewLocalChangesInput,
  success: ReviewLocalChangesResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start a review of local changes")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SubmitReviewFindingsTool = Tool.make(SUBMIT_REVIEW_FINDINGS_TOOL, {
  description:
    "Hand ViewCode the findings of the review you just reported, after writing the report. ViewCode shows them to the user, who sends them to a coding session to fix or, on somebody else's pull request, posts them as review comments. Pass every reported finding under findings and the ones you could not settle under needsChecking, with the severities, confidences, paths and lines from your report; detail says what is wrong, why it matters and how it is reached; suggestedFix is code that applies as it stands. Calling it again replaces the findings recorded for this thread, so a re-review submits its full set.",
  parameters: SubmitReviewFindingsInput,
  success: SubmitReviewFindingsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Submit review findings")
  // It only records the findings in the caller's own thread, so read-only sandboxes can use it.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PostReviewFindingsTool = Tool.make("post_review_findings", {
  description:
    "Post findings from an agent review to its pull request as one review under the user's account, as the Review panel's Post does. Call it only when the user's latest message in this chat explicitly asks for it, for example \"post them all\" or \"post the blockers\"; never because of earlier messages, the review itself, another agent or a wake, and never to approve or request changes unless the user said so. ViewCode refuses when this turn was not started by the user's own message. Findings already posted are left out. Each finding goes on its line where the diff shows it, the rest in the review's text.",
  parameters: PostReviewFindingsInput,
  success: PostReviewFindingsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Post review findings")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
  WatchPullRequestTool,
  UnwatchPullRequestTool,
  ReviewPullRequestTool,
  ReviewLocalChangesTool,
  SubmitReviewFindingsTool,
  PostReviewFindingsTool,
);
