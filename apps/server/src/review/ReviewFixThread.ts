import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ReviewFixThreadError,
  ThreadId,
  type ReviewStartFixThreadInput,
  type ReviewStartFixThreadResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { buildReviewFixMessage } from "@t3tools/shared/reviewFindings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Starts a new session that fixes findings from an agent review. A pull request review's session
 * works on the pull request's head in a worktree of its own, so the user's checkout stays where
 * it is, and is linked to the pull request; a local review's session works where the review did.
 * It runs on the project's defaults for new threads, falling back to the reviewer's model.
 *
 * Sending findings to a session that already exists is the client's job: it goes through the
 * composer's queue, which already knows when a busy thread can take a message.
 */
export class ReviewFixThread extends Context.Service<
  ReviewFixThread,
  {
    readonly start: (
      input: ReviewStartFixThreadInput,
    ) => Effect.Effect<ReviewStartFixThreadResult, ReviewFixThreadError>;
  }
>()("t3/review/ReviewFixThread") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const start = Effect.fn("ReviewFixThread.start")(function* (input: ReviewStartFixThreadInput) {
    const failure =
      (stage: ReviewFixThreadError["stage"]) =>
      (cause: unknown): ReviewFixThreadError =>
        new ReviewFixThreadError({ stage, cause });

    const review = yield* snapshots
      .getThreadShellById(input.reviewThreadId)
      .pipe(Effect.mapError(failure("review-thread")));
    if (Option.isNone(review)) {
      return yield* new ReviewFixThreadError({ stage: "review-thread" });
    }
    const project = yield* snapshots
      .getProjectShellById(review.value.projectId)
      .pipe(Effect.mapError(failure("project")));
    if (Option.isNone(project)) return yield* new ReviewFixThreadError({ stage: "project" });
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failure("settings")));
    const defaults = resolveProjectSettings(settings, project.value.id, project.value).settings;
    const modelSelection = defaults.defaultModelSelection ?? review.value.modelSelection;
    const runtimeMode = defaults.defaultRuntimeMode;
    const { target } = input;

    const threadId = ThreadId.make(yield* uuid);
    const checkout =
      target.kind === "pull-request"
        ? yield* git
            .preparePullRequestThread({
              cwd: project.value.workspaceRoot,
              reference: target.url,
              mode: "worktree",
              threadId,
            })
            .pipe(
              Effect.map((prepared) => ({
                branch: prepared.branch,
                worktreePath: prepared.worktreePath,
                title: `Fix review findings: #${target.number} ${prepared.pullRequest.title}`,
              })),
              Effect.mapError(
                (cause) =>
                  new ReviewFixThreadError({ stage: "checkout", detail: cause.message, cause }),
              ),
            )
        : {
            branch: review.value.branch,
            worktreePath: review.value.worktreePath,
            title: `Fix review findings: ${review.value.title}`,
          };

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:review-fix:${threadId}`),
        threadId,
        projectId: project.value.id,
        title: checkout.title,
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: checkout.branch,
        worktreePath: checkout.worktreePath,
        createdAt,
      })
      .pipe(Effect.mapError(failure("create-thread")));
    if (target.kind === "pull-request") {
      yield* engine
        .dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`server:review-fix-link:${threadId}`),
          threadId,
          host: target.host,
          repository: target.repository,
          number: target.number,
          url: target.url,
          source: "manual",
        })
        .pipe(Effect.mapError(failure("link")));
    }
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:review-fix-turn:${threadId}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: buildReviewFixMessage({
            reviewTitle: review.value.title,
            target,
            findings: input.findings,
          }),
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      })
      .pipe(Effect.mapError(failure("start-turn")));
    return { threadId, title: checkout.title };
  });

  return ReviewFixThread.of({ start });
});

export const layer = Layer.effect(ReviewFixThread, make);
