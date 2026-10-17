import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  ReviewFixStartedActivityPayload,
  ReviewFixThreadError,
  ReviewUndoFixesError,
  ThreadId,
  type ReviewStartFixThreadInput,
  type ReviewStartFixThreadResult,
  type ReviewUndoFixesInput,
  type ReviewUndoFixesResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { buildReviewFixMessage } from "@t3tools/shared/reviewFindings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewActivityStore from "../review/ReviewActivityStoreV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ReviewThreadContext from "../review/ReviewThreadContextV2.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Starts a new session that fixes findings from an agent review. A pull request review's session
 * works on the pull request's head in a worktree, reusing its checkout when no session is working
 * there, and is linked to the pull request; a local review's session works where the review did.
 * It runs on the project's defaults for new threads, falling back to the reviewer's model.
 *
 * Sending findings to a session that already exists is the client's job: it goes through the
 * composer's queue, which already knows when a busy thread can take a message.
 *
 * A session started here records that it fixes findings and where it started, so `undo` can put
 * it back: files and conversation, through the same checkpoint revert the chat offers. A message
 * a client sends to an existing session carries no such record (a turn start has no field for
 * it), so only these sessions can be undone this way.
 */
const decodeFixStarted = Schema.decodeUnknownOption(ReviewFixStartedActivityPayload);

export class ReviewFixThread extends Context.Service<
  ReviewFixThread,
  {
    readonly start: (
      input: ReviewStartFixThreadInput,
    ) => Effect.Effect<ReviewStartFixThreadResult, ReviewFixThreadError>;
    /** Reverts a session `start` created to its checkpoint before the fix. */
    readonly undo: (
      input: ReviewUndoFixesInput,
    ) => Effect.Effect<ReviewUndoFixesResult, ReviewUndoFixesError>;
  }
>()("t3/review/ReviewFixThread") {}

const make = Effect.gen(function* () {
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
  const git = yield* GitWorkflowService.GitWorkflowService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  const start = Effect.fn("ReviewFixThread.start")(function* (input: ReviewStartFixThreadInput) {
    const failure =
      (stage: ReviewFixThreadError["stage"]) =>
      (cause: unknown): ReviewFixThreadError =>
        new ReviewFixThreadError({ stage, cause });

    const review = yield* readThread(input.reviewThreadId).pipe(
      Effect.mapError(failure("review-thread")),
    );
    if (Option.isNone(review)) {
      return yield* new ReviewFixThreadError({ stage: "review-thread" });
    }
    const project = yield* projects
      .getShell(review.value.projectId)
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

    if (target.kind === "pull-request" && checkout.worktreePath !== null) {
      const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(failure("checkout")));
      const busy = snapshot.threads.some(
        (thread) =>
          thread.id !== threadId &&
          thread.archivedAt === null &&
          thread.worktreePath === checkout.worktreePath &&
          (thread.activeRunId !== null ||
            ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status)),
      );
      if (busy) return yield* new ReviewFixThreadError({ stage: "checkout-busy" });
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* threads
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
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure("create-thread")));
    if (target.kind === "pull-request") {
      yield* threads
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
    // A new session, so the fix is its first turn and undoing it goes back to checkpoint 0.
    const fixStarted: ReviewFixStartedActivityPayload = {
      reviewThreadId: input.reviewThreadId,
      ...(input.findingsActivityId === undefined
        ? {}
        : { findingsActivityId: input.findingsActivityId }),
      turnCountBefore: 0,
    };
    yield* activities
      .append({
        commandId: CommandId.make(`server:review-fix-started:${threadId}`),
        threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: REVIEW_FIX_STARTED_ACTIVITY_KIND,
          summary: "Started fixing review findings",
          payload: { ...fixStarted, timelineBypass: true },
          turnId: null,
          createdAt,
        },
      })
      .pipe(Effect.mapError(failure("start-turn")));
    yield* threads
      .sendToThread({
        commandId: CommandId.make(`server:review-fix-turn:${threadId}`),
        projectId: project.value.id,
        threadId,
        messageId: MessageId.make(yield* uuid),
        text: buildReviewFixMessage({
          reviewTitle: review.value.title,
          target,
          findings: input.findings,
        }),
        attachments: [],
        modelSelection,
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure("start-turn")));

    return { threadId, title: checkout.title };
  });

  const undo = Effect.fn("ReviewFixThread.undo")(function* (input: ReviewUndoFixesInput) {
    const failure =
      (stage: ReviewUndoFixesError["stage"]) =>
      (cause: unknown): ReviewUndoFixesError =>
        new ReviewUndoFixesError({ stage, cause });
    const detail = yield* readThread(input.threadId, {
      activityKinds: [REVIEW_FIX_STARTED_ACTIVITY_KIND],
    }).pipe(Effect.mapError(failure("thread")));
    if (Option.isNone(detail)) return yield* new ReviewUndoFixesError({ stage: "thread" });
    const marker = detail.value.activities.findLast(
      (activity) => activity.kind === REVIEW_FIX_STARTED_ACTIVITY_KIND,
    );
    const started = marker === undefined ? Option.none() : decodeFixStarted(marker.payload);
    if (Option.isNone(started)) return yield* new ReviewUndoFixesError({ stage: "not-a-fix" });
    if (detail.value.activeRunId !== null)
      return yield* new ReviewUndoFixesError({ stage: "running" });
    const projection = yield* threads
      .getThreadProjection(input.threadId)
      .pipe(Effect.mapError(failure("thread")));
    const turnCount = started.value.turnCountBefore;
    const current = projection.runs.reduce((latest, run) => Math.max(latest, run.ordinal), 0);
    if (current <= turnCount) return yield* new ReviewUndoFixesError({ stage: "nothing" });
    const checkpoint = projection.checkpoints.findLast(
      (entry) => (entry.appRunOrdinal ?? 0) === turnCount && entry.status === "ready",
    );
    if (checkpoint === undefined) return yield* new ReviewUndoFixesError({ stage: "nothing" });
    yield* threads
      .dispatch({
        type: "checkpoint.rollback",
        commandId: input.commandId ?? CommandId.make(`server:review-fix-undo:${input.threadId}:${yield* uuid}`),
        threadId: input.threadId,
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        restoreFiles: true,
      })
      .pipe(Effect.mapError(failure("revert")));

    return { turnCount, undoneTurns: current - turnCount };
  });

  return ReviewFixThread.of({ start, undo });
});

export const layer = Layer.effect(ReviewFixThread, make);
