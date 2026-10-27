import {
  CommandId,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * Speak mode "summary" stores one spoken summary per completed turn on its final
 * assistant message, so every client reads the same words aloud. The effect is
 * enqueued when the turn completes (see `CheckpointCaptureService`) and runs in
 * its own outbox lane, so it never delays the next turn.
 */
export const spokenSummaryEffects = (input: {
  readonly settings: Pick<ServerSettingsValue, "speakMode">;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}): ReadonlyArray<PendingOrchestrationEffectV2> =>
  input.settings.speakMode === "summary"
    ? [
        {
          id: `effect:spoken-summary.generate:${input.runId}`,
          commandId: CommandId.make(`command:effect:spoken-summary.generate:${input.runId}`),
          threadId: input.threadId,
          request: { type: "spoken-summary.generate", runId: input.runId },
        },
      ]
    : [];

/**
 * The cheap model of the provider (and account) that ran the turn, like Haiku
 * for an Opus turn; the title model when that provider has no known cheap model.
 */
const spokenSummaryModelSelection = (input: {
  readonly runInstanceId: ProviderInstanceId;
  readonly runDriverKind: ProviderDriverKind | undefined;
  readonly textGenerationModelSelection: ModelSelection;
}): ModelSelection => {
  if (input.textGenerationModelSelection.instanceId === input.runInstanceId) {
    return input.textGenerationModelSelection;
  }
  const model =
    input.runDriverKind === undefined
      ? undefined
      : DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[input.runDriverKind];
  return model === undefined
    ? input.textGenerationModelSelection
    : { instanceId: input.runInstanceId, model };
};

export class ViewCodeSpokenSummaryService extends Context.Service<
  ViewCodeSpokenSummaryService,
  {
    /** Never fails the turn: a failed generation leaves the message without a summary. */
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ViewCodeSpokenSummary/ViewCodeSpokenSummaryService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const finalReply = (threadId: ThreadId, runId: RunId) =>
    projections
      .getThreadRecords(threadId, ["runs", "messages"], {
        runIds: [runId],
        messageRunIds: [runId],
        messageRoles: ["assistant"],
      })
      .pipe(
        Effect.map(({ thread, runs, messages }) => ({
          thread,
          run: runs.find((run) => run.id === runId),
          message: messages.findLast(
            (message) =>
              message.runId === runId &&
              message.role === "assistant" &&
              !message.streaming &&
              message.text.trim().length > 0,
          ),
        })),
      );

  const execute = Effect.fn("ViewCodeSpokenSummaryService.execute")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const { thread, run, message } = yield* finalReply(input.threadId, input.runId);
    if (
      run === undefined ||
      run.status !== "completed" ||
      message === undefined ||
      message.spokenSummary !== undefined
    ) {
      return;
    }
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return;

    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const instance = yield* providers.getInstance(run.providerInstanceId);
    const { summary } = yield* textGeneration.generateSpokenSummary({
      cwd: thread.worktreePath ?? project.value.workspaceRoot,
      message: message.text,
      modelSelection: spokenSummaryModelSelection({
        runInstanceId: run.providerInstanceId,
        runDriverKind: instance?.driverKind,
        textGenerationModelSelection: settings.textGenerationModelSelection,
      }),
    });
    if (summary.length === 0) return;

    // Re-read so a write that landed during generation is kept.
    const latest = (yield* finalReply(input.threadId, input.runId)).message;
    if (latest?.id !== message.id || latest.spokenSummary !== undefined) return;
    const commandId = CommandId.make(`command:effect:spoken-summary.generate:${input.runId}`);
    const now = yield* DateTime.now;
    yield* eventSink.commitCommand({
      commandId,
      threadId: input.threadId,
      commandType: "spoken-summary.generate",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "message.updated",
          threadId: input.threadId,
          runId: input.runId,
          ...(latest.nodeId === null ? {} : { nodeId: latest.nodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...latest, spokenSummary: summary },
        },
      ],
    });
  });

  return ViewCodeSpokenSummaryService.of({
    execute: (input) =>
      execute(input).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Spoken summary generation failed", { ...input, cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ViewCodeSpokenSummaryService, make);
