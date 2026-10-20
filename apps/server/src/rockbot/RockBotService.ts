import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type RockBotOpenInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";

/** One id per environment, so two clients opening RockBot at once get the same thread. */
export const ROCKBOT_THREAD_ID = ThreadId.make("rockbot");

/** RockBot starts on the model of the work the user touched last. */
export function latestModelSource(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShell | null {
  return (
    threads
      .filter((thread) => thread.kind !== "orchestrator" && thread.deletedAt === null)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null
  );
}

/**
 * Why a client command may not make or unmake RockBot, or null when it may run.
 * Only `RockBotService.open` creates RockBot, and its send gate keys off the kind,
 * so a client must not set `orchestrator` or change it away.
 */
export function refusedRockBotKindChange(
  command: { readonly type: string; readonly kind?: string | null | undefined },
  currentKind: string | null | undefined,
): string | null {
  if (
    command.type !== "thread.create" &&
    command.type !== "thread.fork" &&
    command.type !== "thread.metadata.update"
  )
    return null;
  if (command.kind === "orchestrator")
    return "Open RockBot from its button; it cannot be made from another thread.";
  if (command.kind !== undefined && currentKind === "orchestrator") return "RockBot stays RockBot.";
  return null;
}

export class RockBotService extends Context.Service<
  RockBotService,
  {
    readonly open: (
      input: RockBotOpenInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, OrchestrationDispatchCommandError>;
  }
>()("t3/rockbot/RockBotService") {}

const dispatchError = (message: string) => (cause: unknown) =>
  new OrchestrationDispatchCommandError({ message, cause });

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto
    .randomUUIDv4()
    .pipe(Effect.mapError(dispatchError("Could not make an id for RockBot.")));

  const open = Effect.fn("RockBotService.open")(function* (input: RockBotOpenInput) {
    const active = yield* threads
      .listProjectThreads({ includeSubagents: true })
      .pipe(Effect.mapError(dispatchError("Could not list threads to find RockBot.")));
    const existing = active.find((thread) => thread.kind === "orchestrator");
    if (existing !== undefined) return { threadId: existing.id };

    const reserved = yield* threads
      .getThreadShell(ROCKBOT_THREAD_ID)
      .pipe(Effect.mapError(dispatchError("Could not read the RockBot thread.")));
    if (reserved !== null && reserved.deletedAt === null) {
      // Archived from somewhere outside the rail; opening it brings it back.
      yield* threads
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`rockbot-unarchive:${yield* uuid}`),
          threadId: reserved.id,
        })
        .pipe(Effect.mapError(dispatchError("Could not reopen RockBot.")));
      return { threadId: reserved.id };
    }

    const source = latestModelSource(active);
    if (source === null) {
      return yield* new OrchestrationDispatchCommandError({
        message: "Start any thread first, so RockBot knows which model to use.",
      });
    }
    // Scratch keeps RockBot's own files out of every repository; a data dir inside a
    // checkout (a dev worktree) has no Scratch, so it borrows the latest project.
    const projectId = yield* folders.ensureScratchProject.pipe(
      Effect.map((scratch) => scratch.projectId),
      Effect.orElseSucceed(() => source.projectId),
    );
    const threadId =
      reserved === null ? ROCKBOT_THREAD_ID : ThreadId.make(`rockbot:${yield* uuid}`);
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`rockbot-create:${threadId}`),
        threadId,
        projectId,
        title: "RockBot",
        kind: "orchestrator",
        modelSelection: source.modelSelection,
        // It only reads; its sends to other threads wait for the user's Send.
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: input.creationSource ?? "web",
      })
      .pipe(Effect.mapError(dispatchError("Could not create RockBot.")));
    return { threadId };
  });

  return RockBotService.of({ open });
});

export const layer = Layer.effect(RockBotService, make);
