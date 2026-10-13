import {
  type AgentReviewMode,
  LocalReviewScope,
  type ReviewCommit,
  type ModelSelection,
  type ProjectId,
  type PullRequestRef,
  type PullRequestStartReviewInput,
  type ReviewBasedOnInput,
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ReviewDiffPreviewSourceKind,
  type ReviewFindingsActivityPayload,
  type ReviewFindingsTarget,
  type ReviewStartLocalInput,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Schema from "effect/Schema";

import { collectChildAgents } from "./state/childAgents.ts";

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

/**
 * How long a review that is over took, to the second under a minute: "took 19s", "took 3 min",
 * "took 1 h 5 min". A running review shows `formatReviewElapsed` instead.
 */
export function formatReviewDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.floor(Math.max(0, durationMs) / 1_000));
  if (seconds < 60) return `took ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `took ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `took ${hours} h ${rest} min` : `took ${hours} h`;
}

/**
 * The step a reviewer is on while it sends findings, from its latest set: "Sent 3 findings so far",
 * "Sent 4 findings" for the final set, or "Sending findings" before any arrived.
 */
export function reviewFindingsSentText(
  findings: Pick<ReviewFindingsActivityPayload, "findings" | "needsChecking" | "complete"> | null,
): string {
  if (findings === null) return "Sending findings";
  const count = findings.findings.length + findings.needsChecking.length;
  const counted = `${count} ${count === 1 ? "finding" : "findings"}`;
  return findings.complete === false ? `Sent ${counted} so far` : `Sent ${counted}`;
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
  /** How long a review that is over took, when known; said after why it stopped. */
  readonly durationMs?: number | null;
  readonly newer: boolean;
}): string | null {
  const { progress, label, newer } = input;
  const took =
    input.durationMs === undefined || input.durationMs === null
      ? ""
      : ` · ${formatReviewDuration(input.durationMs)}`;
  switch (progress.kind) {
    case "done":
      return null;
    case "running":
      return `${newer ? "A new review is running:" : "Reviewing…"} ${label} · ${formatReviewElapsed(input.elapsedMs)}`;
    case "failed":
      return `${newer ? "A new review failed" : "Review failed"}: ${shortReviewError(progress.error)}${took}`;
    case "ended":
      return progress.partial
        ? `The review ended before sending all its findings${took}`
        : `${newer ? "A new review" : "The review"} ended without sending findings${took}`;
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
 * What the review panel says when the reviewed change has no diff in this checkout. A branch with
 * nothing committed past its base is the usual cause: the work is still uncommitted.
 */
export function reviewNoChangesText(
  target: Parameters<typeof reviewedChangeLabel>[0],
  scope: LocalReviewScope | null,
  shownBase: string | null,
): string {
  const label = reviewedChangeLabel(target, scope, shownBase);
  if (scope?.kind === "branch") {
    return `No commits in ${label.toLowerCase()} here. If the work is not committed yet, review Uncommitted instead.`;
  }
  if (scope?.kind === "uncommitted") return "No uncommitted changes here.";
  return `No changes in ${label} here.`;
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

/**
 * What stopping a review does, as two existing agent controls composed: stop the reviewer and the
 * agents of it still at work (each alone, since the chat it belongs to is in the same agent tree),
 * then discard for the reviewer and every agent under it, which unpauses them and drops whatever
 * they hold, so a stopped review looks like a finished one and no held answer wakes the reviewer
 * again. The agents are discarded before the reviewer, so an answer one of them still had for it
 * is dropped first.
 */
export function reviewStopPlan(
  threads: ReadonlyArray<
    Pick<
      OrchestrationThreadShell,
      "id" | "parentThreadId" | "archivedAt" | "session" | "latestTurn"
    > & {
      readonly environmentId: EnvironmentId;
    }
  >,
  review: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): { readonly stop: ReadonlyArray<ThreadId>; readonly discard: ReadonlyArray<ThreadId> } {
  const agents = collectChildAgents(threads, review);
  return {
    stop: [
      review.threadId,
      ...agents.filter((agent) => agent.running).map((agent) => agent.thread.id),
    ],
    discard: [...agents.map((agent) => agent.thread.id), review.threadId],
  };
}

/**
 * A pull request a review can read: the chat's own, or another open one of its project. The title
 * is what the menu shows beside the number; null where it is not known.
 */
export interface ReviewablePullRequest {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
}

/**
 * What a review asked for from a chat reads: a pull request (`own` for the chat's own), or the
 * chat's local changes (`scope` null where the server picks or cannot be told: uncommitted, else
 * the branch).
 */
export type AgentReviewTarget =
  | {
      readonly kind: "pull-request";
      readonly pullRequest: ReviewablePullRequest;
      readonly own: boolean;
      /** Somebody asked the reader to review it. */
      readonly requested?: boolean;
    }
  | { readonly kind: "local"; readonly scope: LocalReviewScope | null };

/** What of a chat's work there is to review, and what its server can review. */
export interface AgentReviewChanges {
  /** The chat's current pull request, where the server reviews pull requests. */
  readonly pullRequest: ReviewablePullRequest | null;
  /**
   * The project's open pull requests, newest first, where the server reviews pull requests: a
   * chat often has several open at once and a review of any of them can be asked for from it.
   */
  readonly openPullRequests?: ReadonlyArray<ReviewablePullRequest> | undefined;
  /** The project's open pull requests the reader's review is requested on, newest first. */
  readonly reviewRequested?: ReadonlyArray<ReviewablePullRequest> | undefined;
  /** Whether the checkout has uncommitted changes; null while that is unknown. */
  readonly dirty: boolean | null;
  /** The branch's committed changes and the base they are against; null when it has none. */
  readonly branch: { readonly base: string | null } | null;
  /** The server reviews local changes (`localAgentReview`). */
  readonly canReviewLocal: boolean;
  /** The server reads what of them to review (`localAgentReviewScope`). */
  readonly canScope: boolean;
}

/** How many of the project's other open pull requests a menu offers. */
export const OTHER_REVIEWABLE_PULL_REQUEST_LIMIT = 8;

function samePullRequest(left: ReviewablePullRequest, right: ReviewablePullRequest): boolean {
  return (
    left.number === right.number &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

function localChoices(changes: AgentReviewChanges): AgentReviewTarget[] {
  if (!changes.canReviewLocal) return [];
  if (!changes.canScope || changes.dirty === null) {
    return changes.dirty !== false || changes.branch !== null
      ? [{ kind: "local", scope: null }]
      : [];
  }
  const choices: AgentReviewTarget[] = [];
  if (changes.dirty) choices.push({ kind: "local", scope: { kind: "uncommitted" } });
  if (changes.branch !== null) {
    const { base } = changes.branch;
    choices.push({
      kind: "local",
      scope: base === null ? { kind: "branch" } : { kind: "branch", base },
    });
  }
  return choices;
}

/**
 * What a review asked for from a chat can read, in the order offered: its pull request, its
 * uncommitted changes, its branch against the base, the pull requests waiting for the reader's
 * review, then the project's other open pull requests.
 * A server that cannot be told what of the local changes to read gets one "local changes" choice,
 * as does a checkout not read yet. Nothing without changes is offered; a commit is picked on its
 * own.
 */
export function agentReviewTargetChoices(
  changes: AgentReviewChanges,
): ReadonlyArray<AgentReviewTarget> {
  const own = changes.pullRequest;
  const notOwn = (pullRequest: ReviewablePullRequest) =>
    own === null || !samePullRequest(pullRequest, own);
  const requested = (changes.reviewRequested ?? [])
    .filter(notOwn)
    .slice(0, OTHER_REVIEWABLE_PULL_REQUEST_LIMIT);
  const others = (changes.openPullRequests ?? [])
    .filter(
      (pullRequest) =>
        notOwn(pullRequest) && !requested.some((asked) => samePullRequest(asked, pullRequest)),
    )
    .slice(0, OTHER_REVIEWABLE_PULL_REQUEST_LIMIT);
  return [
    ...(own === null ? [] : [{ kind: "pull-request" as const, pullRequest: own, own: true }]),
    ...localChoices(changes),
    ...requested.map((pullRequest) => ({
      kind: "pull-request" as const,
      pullRequest,
      own: false,
      requested: true,
    })),
    ...others.map((pullRequest) => ({ kind: "pull-request" as const, pullRequest, own: false })),
  ];
}

/**
 * What a review reads unless the reader picks otherwise, from the diff they are looking at: the
 * uncommitted changes, for those or for one turn's while the tree is dirty; otherwise what is
 * committed, the chat's pull request or else the branch against its base. A diff with nothing in
 * it falls to the other. Another pull request is only ever picked. Null when there is nothing to
 * review.
 */
export function inferAgentReviewTarget(
  section: ReviewDiffPreviewSourceKind | "turn" | null,
  changes: AgentReviewChanges,
): AgentReviewTarget | null {
  const choices = agentReviewTargetChoices(changes);
  const uncommitted = choices.find(
    (choice) =>
      choice.kind === "local" && (choice.scope === null || choice.scope.kind === "uncommitted"),
  );
  const committed =
    choices.find((choice) => choice.kind === "pull-request" && choice.own) ??
    choices.find((choice) => choice.kind === "local" && choice.scope?.kind === "branch");
  return (
    (section === "branch-range" ? (committed ?? uncommitted) : (uncommitted ?? committed)) ?? null
  );
}

/** The request that reviews a target as the chat's agent. */
export function agentReviewTargetRequest(
  target: AgentReviewTarget,
  chat: { readonly projectId: ProjectId; readonly threadId: ThreadId },
): AgentReviewRequest {
  if (target.kind === "local") {
    return { kind: "local", projectId: chat.projectId, sourceThreadId: chat.threadId };
  }
  const { host, repository, number } = target.pullRequest;
  return {
    kind: "pull-request",
    reference: { projectId: chat.projectId, host, repository, number },
    sourceThreadId: chat.threadId,
  };
}

/**
 * What Try again asks for: the review again on what it read, as the same chat's agent. What it
 * read is its findings' target when it sent any; otherwise a local review records any scope it
 * was given, and a pull request review is linked to the pull request. Null for a local review
 * that belongs to no chat, which there is no checkout to name for.
 */
export function agentReviewRetryRequest(input: {
  readonly reviewer: {
    readonly projectId: ProjectId;
    readonly parentThreadId?: ThreadId | null | undefined;
    readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  };
  readonly scope: LocalReviewScope | null;
  readonly findingsTarget: ReviewFindingsTarget | null;
}): AgentReviewRequest | null {
  const { reviewer, findingsTarget } = input;
  const sourceThreadId = reviewer.parentThreadId ?? undefined;
  const pullRequest =
    findingsTarget?.kind === "pull-request"
      ? findingsTarget
      : findingsTarget === null && input.scope === null
        ? resolveThreadCurrentPullRequestLink(visibleThreadPullRequests(reviewer.pullRequests))
        : null;
  if (pullRequest !== null) {
    const { host, repository, number } = pullRequest;
    return {
      kind: "pull-request",
      reference: { projectId: reviewer.projectId, host, repository, number },
      sourceThreadId,
    };
  }
  return sourceThreadId === undefined
    ? null
    : { kind: "local", projectId: reviewer.projectId, sourceThreadId };
}

/** A target's identity, to tell the chosen one among a menu's choices. */
export function agentReviewTargetKey(target: AgentReviewTarget): string {
  if (target.kind === "pull-request") {
    const { host, repository, number } = target.pullRequest;
    return `pull-request:${host.toLowerCase()}/${repository.toLowerCase()}#${number}`;
  }
  switch (target.scope?.kind) {
    case undefined:
      return "local";
    case "uncommitted":
      return "local:uncommitted";
    case "branch":
      return `local:branch:${target.scope.base ?? ""}`;
    case "commit":
      return `local:commit:${target.scope.sha}`;
  }
}

const PULL_REQUEST_TITLE_LIMIT = 48;

/**
 * A target as a menu offers it: "This PR #12", "PR #9 · Fix the login race", "Current changes",
 * "Branch vs origin/main". Another pull request's title is cut short to fit a menu row.
 */
export function agentReviewTargetLabel(target: AgentReviewTarget): string {
  if (target.kind === "pull-request") {
    const { number, title } = target.pullRequest;
    if (target.own) return `This PR #${number}`;
    if (title === null) return `PR #${number}`;
    const short =
      title.length > PULL_REQUEST_TITLE_LIMIT
        ? `${title.slice(0, PULL_REQUEST_TITLE_LIMIT - 1).trimEnd()}…`
        : title;
    return `PR #${number} · ${short}`;
  }
  switch (target.scope?.kind) {
    case undefined:
      return "Local changes";
    case "uncommitted":
      return "Current changes";
    case "branch":
      return `Branch vs ${target.scope.base ?? "its base"}`;
    case "commit":
      return `Commit ${target.scope.sha.slice(0, 7)}`;
  }
}
