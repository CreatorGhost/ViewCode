import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  ReviewCommitSha,
  ThreadId,
  type AgentReviewMode,
  type LocalReviewScope,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProjectId,
  type PullRequestRef,
  type RuntimeMode,
  type PullRequestStartReviewResult,
  type PullRequestSummary,
  type ReviewBasedOn,
  type ReviewBasedOnInput,
  type ReviewFindingsActivityPayload,
  type ReviewFindingsMode,
  type ReviewStartedActivityPayload,
  type ThreadPullRequestLinkSource,
} from "@t3tools/contracts";
import {
  AGENT_MESSAGE_SENT_ACTIVITY_KIND,
  type AgentMessageSentPayload,
} from "@t3tools/shared/agentMessages";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { readReviewFindings, reviewStyleKey } from "@t3tools/shared/reviewFindings";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewActivityStore from "../review/ReviewActivityStoreV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ReviewThreadContext from "../review/ReviewThreadContextV2.ts";
import { findLearnedReviewStyleFile } from "../review/LearnedReviewStyles.ts";
import * as ReviewFindingRatings from "../review/ReviewFindingRatings.ts";
import {
  ensureReviewPlaybook,
  reviewModeLabel,
  SUBMIT_REVIEW_FINDINGS_TOOL,
} from "../review/ReviewPlaybook.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestService from "./PullRequestService.ts";
import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

export class PullRequestAgentReviewError extends Schema.TaggedError<PullRequestAgentReviewError>()(
  "PullRequestAgentReviewError",
  {
    stage: Schema.Literals([
      "project",
      "source-thread",
      "based-on",
      "settings",
      "model",
      "link-key",
      "playbook",
      "create-thread",
      "link",
      "record-start",
      "start-turn",
    ]),
    projectId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "project":
        return "The review's project was not found.";
      case "source-thread":
        return "The thread whose changes were to be reviewed was not found in this project.";
      case "based-on":
        return "The earlier review to start from was not found, or reviewed something else.";
      case "settings":
        return "Could not read the default settings for new threads.";
      case "model":
        return "No model to review with. Choose one, or set a default model for new threads.";
      case "link-key":
        return "This pull request cannot be linked to a thread.";
      case "playbook":
        return "Could not write the review playbook to the server's state directory.";
      case "create-thread":
        return "Could not create the review thread.";
      case "link":
        return "The review thread was created, but the pull request could not be linked to it.";
      case "record-start":
        return "The review thread was created, but the review could not be recorded on it.";
      case "start-turn":
        return "The review thread was created, but the review could not be started.";
    }
  }
}

export interface PullRequestAgentReviewInput {
  readonly reference: PullRequestRef;
  /** Absent: a quick review. */
  readonly mode?: AgentReviewMode | undefined;
  /** Absent: the project's default model for new threads, then `fallbackModelSelection`. */
  readonly modelSelection?: ModelSelection | undefined;
  readonly fallbackModelSelection?: ModelSelection | undefined;
  readonly focus?: string | undefined;
  /** Absent: decided from the pull request's author when the findings are recorded. */
  readonly findingsMode?: ReviewFindingsMode | undefined;
  /** Re-review from the findings in `basedOn`; ignored without them. */
  readonly incremental?: boolean | undefined;
  readonly basedOn?: ReviewBasedOnInput | undefined;
  /** "manual" when a user asked for the review, "agent" when an agent did. */
  readonly linkSource: ThreadPullRequestLinkSource;
  /** The chat the review was asked for from, which the reviewer runs as a child agent of. */
  readonly sourceThreadId?: ThreadId | undefined;
}

/**
 * A review of a checkout's own changes: the source thread's branch and worktree, or the project's
 * workspace when there is no thread. The review thread runs there and changes nothing.
 */
export interface LocalAgentReviewInput {
  readonly projectId: ProjectId;
  /** The chat whose checkout to review; the reviewer runs as its child agent. */
  readonly sourceThreadId?: ThreadId | undefined;
  /** Absent: a quick review. */
  readonly mode?: AgentReviewMode | undefined;
  /** Absent: the project's default model for new threads, then `fallbackModelSelection`. */
  readonly modelSelection?: ModelSelection | undefined;
  readonly fallbackModelSelection?: ModelSelection | undefined;
  readonly focus?: string | undefined;
  readonly incremental?: boolean | undefined;
  readonly basedOn?: ReviewBasedOnInput | undefined;
  /** Absent: the uncommitted changes, or the branch when there are none. */
  readonly scope?: LocalReviewScope | undefined;
}

/** Who opened a pull request and who it is read as; null where the host could not say. */
export interface PullRequestAuthorship {
  readonly author: string | null;
  readonly viewer: string | null;
  /** The reader's other accounts on the host, where its CLI holds several. */
  readonly viewerLogins?: ReadonlyArray<string> | undefined;
}

/**
 * What a review's findings are for: fixes on the reader's own pull request, review comments on
 * somebody else's. Without both names nobody can be told apart, and fixing is the choice that
 * posts nothing.
 */
export function reviewFindingsModeFor(authorship: PullRequestAuthorship): ReviewFindingsMode {
  const { author, viewer } = authorship;
  if (author === null || viewer === null) return "fix";
  const own = [viewer, ...(authorship.viewerLogins ?? [])].some(
    (login) => login.toLowerCase() === author.toLowerCase(),
  );
  return own ? "fix" : "comment";
}

/**
 * Starts an agent review of a pull request in a new thread on the reference's project. The thread
 * is an ordinary one: linked to the pull request, titled after it, and running the user's default
 * permissions for new threads, so the user can keep talking to the reviewer afterwards. Asked for
 * from a chat, it is that chat's child agent, shown in it like one the chat's agent spawned.
 */
export class PullRequestAgentReview extends Context.Service<
  PullRequestAgentReview,
  {
    readonly start: (
      input: PullRequestAgentReviewInput,
    ) => Effect.Effect<
      PullRequestStartReviewResult,
      PullRequestService.PullRequestError | PullRequestAgentReviewError
    >;
    /** Starts an agent review of uncommitted changes, or of the branch when there are none. */
    readonly startLocal: (
      input: LocalAgentReviewInput,
    ) => Effect.Effect<PullRequestStartReviewResult, PullRequestAgentReviewError>;
    /** Never fails: a host that cannot say leaves both names null. */
    readonly authorship: (reference: PullRequestRef) => Effect.Effect<PullRequestAuthorship>;
  }
>()("t3/pullRequest/PullRequestAgentReview") {}

const HOST_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  unknown: "Unknown host",
};

/** The ref a host publishes a change's head under, which also reaches a fork's branch. */
function hostHeadRef(pr: Pick<PullRequestSummary, "provider" | "number" | "headBranch">) {
  switch (pr.provider) {
    case "github":
    case "forgejo":
      return `pull/${pr.number}/head`;
    case "gitlab":
      return `merge-requests/${pr.number}/head`;
    case "azure-devops":
      return `pull/${pr.number}/merge`;
    default:
      return pr.headBranch;
  }
}

const TITLE_PREFIXES: Record<AgentReviewMode, string> = {
  quick: "Review",
  deep: "Deep review",
  security: "Security audit",
};

/** What a re-review is told: where the earlier findings are, and what to read again. */
export interface ReReview {
  readonly previousPath: string;
  /** The commit the earlier review read and the one this one reads, where both are known. */
  readonly previousHeadSha?: string | undefined;
  readonly headSha?: string | undefined;
}

/** The re-review paragraph of a first message: what to review, and what to check again. */
export function reReviewLines(reReview: ReReview): ReadonlyArray<string> {
  const { previousHeadSha, headSha } = reReview;
  const scope =
    previousHeadSha === undefined || headSha === undefined
      ? "Review the whole change again."
      : previousHeadSha === headSha
        ? `Nothing was pushed since that review read commit ${previousHeadSha}, so there is nothing new to review.`
        : `That review read commit ${previousHeadSha}. Review only what changed since: \`git diff ${previousHeadSha} ${headSha}\` (fetch the head first), and the code those changes reach.`;
  return [
    "",
    `This is a re-review. The previous review's findings are in ${reReview.previousPath} (see the playbook's Re-review section).`,
    scope,
    `Then check every previous finding against the code as it is now, and when you call ${SUBMIT_REVIEW_FINDINGS_TOOL}, include each one still open again and pass previous with how many were fixed and how many are still open.`,
  ];
}

function ratedFindingsLines(path: string | null | undefined): ReadonlyArray<string> {
  return path === null || path === undefined
    ? []
    : [
        "",
        `How I rated findings of earlier reviews in this project is in ${path} (see the playbook).`,
      ];
}

export function pullRequestReviewTitle(
  mode: AgentReviewMode,
  pr: Pick<PullRequestSummary, "number" | "title">,
): string {
  return `${TITLE_PREFIXES[mode]}: #${pr.number} ${pr.title}`;
}

/**
 * The first message of a review thread: the mode, the pull request and where the playbook is.
 * Short on purpose; the method lives in the playbook.
 */
export function buildPullRequestReviewPrompt(input: {
  readonly mode: AgentReviewMode;
  readonly playbookPath: string;
  readonly pr: Pick<
    PullRequestSummary,
    "provider" | "repository" | "url" | "number" | "title" | "headBranch" | "baseBranch"
  >;
  readonly focus?: string | undefined;
  /** The head commit to review, which the findings are pinned to; absent when the host did not say. */
  readonly headSha?: string | undefined;
  /** Only a mode the user chose; otherwise the server decides when the findings arrive. */
  readonly findingsMode?: ReviewFindingsMode | undefined;
  readonly reReview?: ReReview | undefined;
  /** The project's recently rated findings, when any were rated. */
  readonly ratedFindingsPath?: string | null | undefined;
  /**
   * Present when the findings will be posted as review comments: the user's style, and the
   * file of their own past review comments learned for the account they will be posted as.
   */
  readonly comments?:
    | { readonly style: string | null; readonly samplesPath: string | null }
    | undefined;
}): string {
  const { pr } = input;
  const lines = [
    `${reviewModeLabel(input.mode)} of pull request #${pr.number}: ${pr.title}`,
    pr.url,
    `${HOST_LABELS[pr.provider]} ${pr.repository}, ${pr.headBranch} into ${pr.baseBranch} (head ref ${hostHeadRef(pr)}).`,
    ...(input.headSha === undefined
      ? []
      : [
          `Review head commit ${input.headSha}. If the pull request has moved past it, still review that commit: your findings are pinned to it.`,
        ]),
    "",
    `Read the review playbook at ${input.playbookPath} and follow it for this pull request. Do not change my working tree, and post nothing to the host unless I ask.`,
  ];
  const focus = input.focus?.trim();
  if (focus) lines.push("", `Focus on: ${focus}`);
  if (input.reReview !== undefined) lines.push(...reReviewLines(input.reReview));
  lines.push(...ratedFindingsLines(input.ratedFindingsPath));
  if (input.findingsMode !== undefined) {
    lines.push(
      "",
      `When you call ${SUBMIT_REVIEW_FINDINGS_TOOL}, pass mode "${input.findingsMode}".`,
    );
  }
  if (input.comments !== undefined) {
    lines.push(
      "",
      "I will post your findings to this pull request as my review comments, so write each finding's detail as the comment itself (see the playbook's Report section).",
    );
    if (input.comments.samplesPath !== null) {
      lines.push(
        "",
        `Write them the way I write reviews: my past review comments are in ${input.comments.samplesPath} (see the playbook).`,
      );
    }
    if (input.comments.style !== null) {
      lines.push("", "Write them in my review style:", "", input.comments.style);
    }
  }
  return lines.join("\n");
}

/**
 * The title of a review of local changes: what it reads when the reader chose ("Deep review:
 * branch vs origin/main", "Review: commit 7523ce0", "Security audit: uncommitted changes"), else
 * the checkout's local changes.
 */
export function localReviewTitle(
  mode: AgentReviewMode,
  branch: string | null,
  scope?: LocalReviewScope | undefined,
): string {
  const prefix = TITLE_PREFIXES[mode];
  switch (scope?.kind) {
    case undefined:
      return `${prefix}: local changes${branch === null ? "" : ` on ${branch}`}`;
    case "uncommitted":
      return `${prefix}: uncommitted changes`;
    case "branch":
      return `${prefix}: branch vs ${scope.base ?? "its base"}`;
    case "commit":
      return `${prefix}: commit ${scope.sha.slice(0, 7)}`;
  }
}

/**
 * The first message of a review of local changes: the mode, where the checkout is, what to diff
 * and where the playbook is.
 */
/** What a review of local changes is told to read, in its first message. */
export function localReviewScopeLine(scope: LocalReviewScope | undefined): string {
  switch (scope?.kind) {
    case undefined:
      return "Review the uncommitted changes there: `git status`, `git diff HEAD` and the untracked files (`git ls-files --others --exclude-standard`). If there are none, review the branch against the branch it was made from instead (`git diff <base>...HEAD`, with <base> the remote's default branch), and say which of the two you reviewed.";
    case "uncommitted":
      return "Review the uncommitted changes there, and only those: `git status`, `git diff HEAD` and the untracked files (`git ls-files --others --exclude-standard`).";
    case "branch":
      return scope.base === undefined
        ? "Review the branch against the branch it was made from: `git diff <base>...HEAD`, with <base> the remote's default branch. Leave out uncommitted changes."
        : `Review the branch against \`${scope.base}\`: \`git diff ${scope.base}...HEAD\`. Leave out uncommitted changes.`;
    case "commit":
      return `Review commit ${scope.sha} and only that commit: \`git show ${scope.sha}\`.`;
  }
}

export function buildLocalReviewPrompt(input: {
  readonly mode: AgentReviewMode;
  readonly playbookPath: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly scope?: LocalReviewScope | undefined;
  readonly focus?: string | undefined;
  readonly reReview?: ReReview | undefined;
  readonly ratedFindingsPath?: string | null | undefined;
}): string {
  const lines = [
    `${reviewModeLabel(input.mode)} of the local changes in ${input.cwd}${input.branch === null ? "" : ` on branch ${input.branch}`}.`,
    "",
    localReviewScopeLine(input.scope),
    "",
    `Read the review playbook at ${input.playbookPath} and follow it for these changes. Do not change my working tree, index or branch, and post nothing to the host.`,
  ];
  const focus = input.focus?.trim();
  if (focus) lines.push("", `Focus on: ${focus}`);
  if (input.reReview !== undefined) lines.push(...reReviewLines(input.reReview));
  lines.push(...ratedFindingsLines(input.ratedFindingsPath));
  lines.push("", `When you call ${SUBMIT_REVIEW_FINDINGS_TOOL}, pass target "local".`);
  return lines.join("\n");
}

/** The focus a review was asked for, as recorded with its start for a retry to ask again. */
function reviewFocus(focus: string | undefined): { readonly focus?: string } {
  const trimmed = focus?.trim();
  return trimmed ? { focus: trimmed } : {};
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Where a re-review's earlier findings are written for the reviewer, below the state directory. */
const PREVIOUS_FINDINGS_DIR = "review-previous";

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const ratings = yield* ReviewFindingRatings.ReviewFindingRatings;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const readThread = (
    threadId: import("@t3tools/contracts").ThreadId,
    options?: { readonly activityKinds?: ReadonlyArray<string>; readonly allActivities?: boolean },
  ) =>
    ReviewThreadContext.read(threadId, options?.activityKinds).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(ReviewActivityStore.ReviewActivityStoreV2, activities),
    );
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  // The detail names who opened it, who reads it and its head, and is usually cached from the
  // page the review started on. A host that cannot say leaves each unknown.
  const isCommitSha = Schema.is(ReviewCommitSha);
  const readDetail = (reference: PullRequestRef) =>
    pullRequests.detail(reference).pipe(
      Effect.map((detail) => ({
        authorship: {
          author: detail.author?.login ?? null,
          viewer: detail.viewer ?? null,
          viewerLogins: detail.viewerLogins,
        } satisfies PullRequestAuthorship,
        headSha:
          detail.headSha !== undefined && isCommitSha(detail.headSha) ? detail.headSha : undefined,
      })),
      Effect.catch((error) =>
        Effect.logWarning("Could not read the reviewed pull request's detail", {
          detail: error.message,
        }).pipe(
          Effect.as({
            authorship: { author: null, viewer: null } as PullRequestAuthorship,
            headSha: undefined,
          }),
        ),
      ),
    );
  const readAuthorship = (reference: PullRequestRef) =>
    readDetail(reference).pipe(Effect.map((detail) => detail.authorship));

  // Outside any turn, so reverting the review's turns keeps what the review was started on.
  const recordReviewStarted = (
    threadId: ThreadId,
    payload: ReviewStartedActivityPayload,
    createdAt: string,
  ) =>
    Effect.gen(function* () {
      yield* activities.append({
        commandId: CommandId.make(`server:review-started:${threadId}`),
        threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: REVIEW_STARTED_ACTIVITY_KIND,
          summary: "Review started",
          payload: { ...payload, timelineBypass: true },
          turnId: null,
          createdAt,
        },
      });
    });

  /**
   * Creates the review thread, records what the review started on and sends the first message.
   * A pull request review is linked to the pull request in between. Asked for from a chat, the
   * reviewer is its child agent and the chat records it the way it records an agent it spawned,
   * so its transcript shows the review in its place.
   */
  const launch = Effect.fn("PullRequestAgentReview.launch")(function* (input: {
    readonly projectId: ProjectId;
    readonly parentThreadId: ThreadId | null;
    readonly mode: AgentReviewMode;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly link?: Omit<
      Extract<OrchestrationV2Command, { type: "thread.pull-request.link" }>,
      "type" | "commandId" | "threadId"
    >;
    readonly started: ReviewStartedActivityPayload;
    readonly text: string;
  }) {
    const failure =
      (stage: PullRequestAgentReviewError["stage"]) =>
      (cause: unknown): PullRequestAgentReviewError =>
        new PullRequestAgentReviewError({ stage, projectId: input.projectId, cause });
    const threadId = ThreadId.make(yield* uuid);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const { modelSelection, runtimeMode } = input;
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:pr-review:${threadId}`),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: input.branch,
        worktreePath: input.worktreePath,
        ...(input.parentThreadId === null ? {} : { parentThreadId: input.parentThreadId }),
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure("create-thread")));
    if (input.link !== undefined) {
      yield* threads
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`server:pr-review-link:${threadId}`),
          threadId,
          ...input.link,
        })
        .pipe(Effect.mapError(failure("link")));
    }
    yield* recordReviewStarted(threadId, input.started, createdAt).pipe(
      Effect.mapError(failure("record-start")),
    );
    const messageId = MessageId.make(yield* uuid);
    yield* threads
      .sendToThread({
        commandId: CommandId.make(`server:pr-review-turn:${threadId}`),
        projectId: input.projectId,
        threadId,
        messageId,
        text: input.text,
        attachments: [],
        modelSelection,
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure("start-turn")));

    if (input.parentThreadId !== null) {
      // Nothing is sent back to the chat: the findings reach it through the Review panel.
      const spawned: AgentMessageSentPayload = {
        messageId,
        toThreadId: threadId,
        toName: input.title,
        body: input.text,
        replyExpected: false,
        inReplyTo: null,
        kind: "spawn",
        delivery: "started",
        review: input.mode,
      };
      yield* activities
        .append({
          commandId: CommandId.make(`server:review-spawned:${threadId}`),
          threadId: input.parentThreadId,
          activity: {
            id: EventId.make(yield* uuid),
            tone: "info",
            kind: AGENT_MESSAGE_SENT_ACTIVITY_KIND,
            summary: `Started ${input.title}`,
            payload: spawned,
            turnId: null,
            createdAt,
          },
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return { threadId, title: input.title };
  });

  /** The project, its defaults for new threads and the model to review with. */
  const resolveDefaults = Effect.fn("PullRequestAgentReview.resolveDefaults")(function* (input: {
    readonly projectId: ProjectId;
    readonly modelSelection?: ModelSelection | undefined;
    readonly fallbackModelSelection?: ModelSelection | undefined;
  }) {
    const failure =
      (stage: PullRequestAgentReviewError["stage"]) =>
      (cause: unknown): PullRequestAgentReviewError =>
        new PullRequestAgentReviewError({ stage, projectId: input.projectId, cause });
    const project = yield* projects
      .getShell(input.projectId)
      .pipe(Effect.mapError(failure("project")));
    if (Option.isNone(project)) {
      return yield* new PullRequestAgentReviewError({
        stage: "project",
        projectId: input.projectId,
      });
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failure("settings")));
    const defaults = resolveProjectSettings(settings, input.projectId, project.value).settings;
    const modelSelection =
      input.modelSelection ?? defaults.defaultModelSelection ?? input.fallbackModelSelection;
    if (modelSelection === undefined) {
      return yield* new PullRequestAgentReviewError({
        stage: "model",
        projectId: input.projectId,
      });
    }
    return { project: project.value, settings, defaults, modelSelection };
  });

  const writePlaybook = (projectId: ProjectId, mode: AgentReviewMode) =>
    ensureReviewPlaybook({ stateDir: config.stateDir, mode }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new PullRequestAgentReviewError({ stage: "playbook", projectId, cause }),
      ),
    );

  /**
   * The earlier findings a re-review starts from, written where the reviewer can read them. They
   * must be of the same target, or the re-review would check findings about something else.
   */
  const preparePrevious = Effect.fn("PullRequestAgentReview.preparePrevious")(function* (
    projectId: ProjectId,
    basedOn: ReviewBasedOnInput,
    sameTarget: (payload: ReviewFindingsActivityPayload) => boolean,
  ) {
    const failure = (cause?: unknown) =>
      new PullRequestAgentReviewError({ stage: "based-on", projectId, cause });
    const thread = yield* readThread(basedOn.threadId, {
      activityKinds: [REVIEW_FINDINGS_ACTIVITY_KIND],
    }).pipe(Effect.mapError(failure));
    const activity = Option.getOrUndefined(thread)?.activities.find(
      (entry) => entry.id === basedOn.activityId,
    );
    const payload = activity === undefined ? undefined : readReviewFindings(activity);
    if (
      Option.isNone(thread) ||
      thread.value.projectId !== projectId ||
      payload === undefined ||
      !sameTarget(payload)
    ) {
      return yield* failure();
    }
    const content = encodeJson({
      reviewedCommit: payload.headSha ?? null,
      findings: payload.findings.map((finding, index) => ({
        key: `finding:${index}`,
        ...finding,
      })),
      needsChecking: payload.needsChecking.map((finding, index) => ({
        key: `check:${index}`,
        ...finding,
      })),
    });
    const dir = path.join(config.stateDir, PREVIOUS_FINDINGS_DIR);
    const target = path.join(dir, `${basedOn.activityId}.json`);
    // Two re-reviews of the same findings write the same text; a rename keeps either whole.
    const temporary = `${target}.${yield* uuid}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(dir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, content);
      yield* fileSystem.rename(temporary, target);
    }).pipe(Effect.mapError(failure));
    const recorded: ReviewBasedOn = {
      activityId: basedOn.activityId,
      ...(payload.headSha === undefined ? {} : { headSha: payload.headSha }),
    };
    return { path: target, basedOn: recorded };
  });

  /** The chat a review was asked for from, which must be on the review's project. */
  const readSourceThread = Effect.fn("PullRequestAgentReview.readSourceThread")(function* (
    projectId: ProjectId,
    sourceThreadId: ThreadId | undefined,
  ) {
    if (sourceThreadId === undefined) return null;
    const source = yield* readThread(sourceThreadId).pipe(
      Effect.mapError(
        (cause) => new PullRequestAgentReviewError({ stage: "source-thread", projectId, cause }),
      ),
    );
    if (Option.isNone(source) || source.value.projectId !== projectId) {
      return yield* new PullRequestAgentReviewError({ stage: "source-thread", projectId });
    }
    return source.value;
  });

  const startLocal = Effect.fn("PullRequestAgentReview.startLocal")(function* (
    input: LocalAgentReviewInput,
  ) {
    const mode = input.mode ?? "quick";
    const { project, defaults, modelSelection } = yield* resolveDefaults(input);
    const source = yield* readSourceThread(input.projectId, input.sourceThreadId);
    const branch = source?.branch ?? null;
    const worktreePath = source?.worktreePath ?? null;
    const playbookPath = yield* writePlaybook(input.projectId, mode);
    const previous =
      input.incremental === true && input.basedOn !== undefined
        ? yield* preparePrevious(
            input.projectId,
            input.basedOn,
            (payload) => payload.target.kind === "local",
          )
        : undefined;
    const ratedFindingsPath = yield* ratings.writeRatedFindingsFile(input.projectId);
    // The same checkout as the thread whose changes these are; the reviewer only reads it.
    return yield* launch({
      projectId: input.projectId,
      parentThreadId: source?.id ?? null,
      mode,
      title: localReviewTitle(mode, branch, input.scope),
      modelSelection,
      runtimeMode: defaults.defaultRuntimeMode,
      branch,
      worktreePath,
      started: {
        mode,
        ...reviewFocus(input.focus),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(previous === undefined ? {} : { incremental: true, basedOn: previous.basedOn }),
      },
      text: buildLocalReviewPrompt({
        mode,
        playbookPath,
        scope: input.scope,
        cwd: worktreePath ?? project.workspaceRoot,
        branch,
        focus: input.focus,
        ratedFindingsPath,
        ...(previous === undefined ? {} : { reReview: { previousPath: previous.path } }),
      }),
    });
  });

  const start = Effect.fn("PullRequestAgentReview.start")(function* (
    input: PullRequestAgentReviewInput,
  ) {
    const { reference } = input;
    const mode = input.mode ?? "quick";
    const { project, settings, defaults, modelSelection } = yield* resolveDefaults({
      projectId: reference.projectId,
      modelSelection: input.modelSelection,
      fallbackModelSelection: input.fallbackModelSelection,
    });

    const source = yield* readSourceThread(reference.projectId, input.sourceThreadId);
    const summary = yield* pullRequests.summary(reference);
    // The key the detail view looks linked threads up by, so the review shows up there.
    const parsedUrl = parseChangeRequestUrl(summary.url);
    const key =
      pullRequestSyncKey(reference, project.repositoryIdentity) ??
      (parsedUrl === null ? null : normalizeThreadPullRequestKey(parsedUrl));
    if (key === null) {
      return yield* new PullRequestAgentReviewError({
        stage: "link-key",
        projectId: reference.projectId,
      });
    }
    const playbookPath = yield* writePlaybook(reference.projectId, mode);

    const detail = yield* readDetail(reference);
    const reviewedKey = threadPullRequestKeyOf(key);
    const previous =
      input.incremental === true && input.basedOn !== undefined
        ? yield* preparePrevious(
            reference.projectId,
            input.basedOn,
            (payload) =>
              payload.target.kind === "pull-request" &&
              threadPullRequestKeyOf(payload.target) === reviewedKey,
          )
        : undefined;
    // Somebody else's pull request gets comments written the way this account writes them.
    const authorship = input.findingsMode === "fix" ? null : detail.authorship;
    const viewer = authorship?.viewer ?? null;
    const style =
      viewer === null
        ? ""
        : (settings.pullRequestReviewStyles[reviewStyleKey(key.host, viewer)] ?? "");
    const commenting =
      authorship !== null &&
      (input.findingsMode ?? reviewFindingsModeFor(authorship)) === "comment";
    const samplesPath =
      !commenting || viewer === null
        ? null
        : yield* findLearnedReviewStyleFile({
            stateDir: config.stateDir,
            account: { host: key.host, login: viewer },
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
    const comments = commenting
      ? { style: style.length > 0 ? style : null, samplesPath }
      : undefined;
    const ratedFindingsPath = yield* ratings.writeRatedFindingsFile(reference.projectId);

    return yield* launch({
      projectId: reference.projectId,
      parentThreadId: source?.id ?? null,
      mode,
      title: pullRequestReviewTitle(mode, summary),
      modelSelection,
      runtimeMode: defaults.defaultRuntimeMode,
      // The review reads the change from the host; nothing needs a checkout of its own.
      branch: null,
      worktreePath: null,
      link: { ...key, url: summary.url, source: input.linkSource },
      started: {
        mode,
        ...reviewFocus(input.focus),
        ...(detail.headSha === undefined ? {} : { headSha: detail.headSha }),
        ...(previous === undefined ? {} : { incremental: true, basedOn: previous.basedOn }),
      },
      text: buildPullRequestReviewPrompt({
        mode,
        playbookPath,
        pr: summary,
        focus: input.focus,
        headSha: detail.headSha,
        findingsMode: input.findingsMode,
        comments,
        ratedFindingsPath,
        ...(previous === undefined
          ? {}
          : {
              reReview: {
                previousPath: previous.path,
                previousHeadSha: previous.basedOn.headSha,
                headSha: detail.headSha,
              },
            }),
      }),
    });
  });

  return PullRequestAgentReview.of({ start, startLocal, authorship: readAuthorship });
});

export const layer = Layer.effect(PullRequestAgentReview, make);
