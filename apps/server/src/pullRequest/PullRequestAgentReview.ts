import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type AgentReviewMode,
  type ModelSelection,
  type PullRequestRef,
  type PullRequestStartReviewResult,
  type PullRequestSummary,
  type ReviewFindingsMode,
  type SourceControlProviderKind,
  type ThreadPullRequestLinkSource,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { reviewStyleKey } from "@t3tools/shared/reviewFindings";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
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
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
      "settings",
      "model",
      "link-key",
      "playbook",
      "create-thread",
      "link",
      "start-turn",
    ]),
    projectId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "project":
        return "The pull request's project was not found.";
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
  /** "manual" when a user asked for the review, "agent" when an agent did. */
  readonly linkSource: ThreadPullRequestLinkSource;
}

/** Who opened a pull request and who it is read as; null where the host could not say. */
export interface PullRequestAuthorship {
  readonly author: string | null;
  readonly viewer: string | null;
}

/**
 * What a review's findings are for: fixes on the reader's own pull request, review comments on
 * somebody else's. Without both names nobody can be told apart, and fixing is the choice that
 * posts nothing.
 */
export function reviewFindingsModeFor(authorship: PullRequestAuthorship): ReviewFindingsMode {
  const { author, viewer } = authorship;
  if (author === null || viewer === null) return "fix";
  return author.toLowerCase() === viewer.toLowerCase() ? "fix" : "comment";
}

/**
 * Starts an agent review of a pull request in a new thread on the reference's project. The thread
 * is an ordinary one: linked to the pull request, titled after it, and running the user's default
 * permissions for new threads, so the user can keep talking to the reviewer afterwards.
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
    /** Never fails: a host that cannot say leaves both names null. */
    readonly authorship: (reference: PullRequestRef) => Effect.Effect<PullRequestAuthorship>;
  }
>()("t3/pullRequest/PullRequestAgentReview") {}

const HOST_LABELS: Record<SourceControlProviderKind, string> = {
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
  /** Only a mode the user chose; otherwise the server decides when the findings arrive. */
  readonly findingsMode?: ReviewFindingsMode | undefined;
  /** Present when the findings will be posted as review comments, with the user's style. */
  readonly comments?: { readonly style: string | null } | undefined;
}): string {
  const { pr } = input;
  const lines = [
    `${reviewModeLabel(input.mode)} of pull request #${pr.number}: ${pr.title}`,
    pr.url,
    `${HOST_LABELS[pr.provider]} ${pr.repository}, ${pr.headBranch} into ${pr.baseBranch} (head ref ${hostHeadRef(pr)}).`,
    "",
    `Read the review playbook at ${input.playbookPath} and follow it for this pull request. Do not change my working tree, and post nothing to the host unless I ask.`,
  ];
  const focus = input.focus?.trim();
  if (focus) lines.push("", `Focus on: ${focus}`);
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
    if (input.comments.style !== null) {
      lines.push("", "Write them in my review style:", "", input.comments.style);
    }
  }
  return lines.join("\n");
}

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequestService.PullRequestService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  // The detail names both, and is usually cached from the page the review started on.
  const readAuthorship = (reference: PullRequestRef) =>
    pullRequests.detail(reference).pipe(
      Effect.map((detail): PullRequestAuthorship => ({
        author: detail.author?.login ?? null,
        viewer: detail.viewer ?? null,
      })),
      Effect.catch((error) =>
        Effect.logWarning("Could not read who opened the reviewed pull request", {
          detail: error.message,
        }).pipe(Effect.as<PullRequestAuthorship>({ author: null, viewer: null })),
      ),
    );

  const start = Effect.fn("PullRequestAgentReview.start")(function* (
    input: PullRequestAgentReviewInput,
  ) {
    const { reference } = input;
    const mode = input.mode ?? "quick";
    const failure =
      (stage: PullRequestAgentReviewError["stage"]) =>
      (cause: unknown): PullRequestAgentReviewError =>
        new PullRequestAgentReviewError({ stage, projectId: reference.projectId, cause });

    const project = yield* snapshots
      .getProjectShellById(reference.projectId)
      .pipe(Effect.mapError(failure("project")));
    if (Option.isNone(project)) {
      return yield* new PullRequestAgentReviewError({
        stage: "project",
        projectId: reference.projectId,
      });
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failure("settings")));
    const defaults = resolveProjectSettings(settings, reference.projectId, project.value).settings;
    const modelSelection =
      input.modelSelection ?? defaults.defaultModelSelection ?? input.fallbackModelSelection;
    if (modelSelection === undefined) {
      return yield* new PullRequestAgentReviewError({
        stage: "model",
        projectId: reference.projectId,
      });
    }

    const summary = yield* pullRequests.summary(reference);
    // The key the detail view looks linked threads up by, so the review shows up there.
    const parsedUrl = parseChangeRequestUrl(summary.url);
    const key =
      pullRequestSyncKey(reference, project.value.repositoryIdentity) ??
      (parsedUrl === null ? null : normalizeThreadPullRequestKey(parsedUrl));
    if (key === null) {
      return yield* new PullRequestAgentReviewError({
        stage: "link-key",
        projectId: reference.projectId,
      });
    }
    const playbookPath = yield* ensureReviewPlaybook({ stateDir: config.stateDir, mode }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(failure("playbook")),
    );

    // Somebody else's pull request gets comments written the way this account writes them.
    const authorship = input.findingsMode === "fix" ? null : yield* readAuthorship(reference);
    const viewer = authorship?.viewer ?? null;
    const style =
      viewer === null
        ? ""
        : (settings.pullRequestReviewStyles[reviewStyleKey(key.host, viewer)] ?? "");
    const comments =
      authorship !== null && (input.findingsMode ?? reviewFindingsModeFor(authorship)) === "comment"
        ? { style: style.length > 0 ? style : null }
        : undefined;

    const threadId = ThreadId.make(yield* uuid);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const title = pullRequestReviewTitle(mode, summary);
    const runtimeMode = defaults.defaultRuntimeMode;
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:pr-review:${threadId}`),
        threadId,
        projectId: reference.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        // The review reads the change from the host; nothing needs a checkout of its own.
        branch: null,
        worktreePath: null,
        createdAt,
      })
      .pipe(Effect.mapError(failure("create-thread")));
    yield* engine
      .dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`server:pr-review-link:${threadId}`),
        threadId,
        ...key,
        url: summary.url,
        source: input.linkSource,
      })
      .pipe(Effect.mapError(failure("link")));
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:pr-review-turn:${threadId}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: buildPullRequestReviewPrompt({
            mode,
            playbookPath,
            pr: summary,
            focus: input.focus,
            findingsMode: input.findingsMode,
            comments,
          }),
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      })
      .pipe(Effect.mapError(failure("start-turn")));
    return { threadId, title };
  });

  return PullRequestAgentReview.of({ start, authorship: readAuthorship });
});

export const layer = Layer.effect(PullRequestAgentReview, make);
