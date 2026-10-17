import { CommandId, ThreadGoalObjective, type ThreadGoal, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadGoalThreadNotFoundError extends Schema.TaggedError<ThreadGoalThreadNotFoundError>()(
  "ThreadGoalThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message() {
    return "The thread was not found.";
  }
}
export class ThreadGoalMissingError extends Schema.TaggedError<ThreadGoalMissingError>()(
  "ThreadGoalMissingError",
  { threadId: ThreadId },
) {
  override get message() {
    return "This thread has no goal to pause or resume.";
  }
}
export class ThreadGoalInvalidObjectiveError extends Schema.TaggedError<ThreadGoalInvalidObjectiveError>()(
  "ThreadGoalInvalidObjectiveError",
  { threadId: ThreadId },
) {
  override get message() {
    return "A goal must contain between 1 and 2000 characters.";
  }
}
export class ThreadGoalStoreError extends Schema.TaggedError<ThreadGoalStoreError>()(
  "ThreadGoalStoreError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message() {
    return "The thread's goal or debug mode could not be read or saved.";
  }
}

const decodeObjective = Schema.decodeUnknownEffect(ThreadGoalObjective);

type GoalError =
  | ThreadGoalThreadNotFoundError
  | ThreadGoalMissingError
  | ThreadGoalInvalidObjectiveError
  | ThreadGoalStoreError;
type GoalUpdate = {
  readonly objective?: string | null | undefined;
  readonly paused?: boolean | undefined;
};

/** ViewCode objectives use viewcodeGoal; upstream's native provider goal is independent. */
export class ViewCodeGoals extends Context.Service<
  ViewCodeGoals,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<ThreadGoal | null, GoalError>;
    readonly set: (
      threadId: ThreadId,
      input: GoalUpdate,
    ) => Effect.Effect<ThreadGoal | null, GoalError>;
    readonly getDebug: (threadId: ThreadId) => Effect.Effect<boolean, GoalError>;
    readonly setDebug: (threadId: ThreadId, enabled: boolean) => Effect.Effect<boolean, GoalError>;
  }
>()("t3/orchestration-v2/ViewCodeGoals") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const read = Effect.fn("ViewCodeGoals.read")(function* (threadId: ThreadId) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new ThreadGoalStoreError({ threadId, cause })));
    if (shell === null || shell.deletedAt !== null)
      return yield* new ThreadGoalThreadNotFoundError({ threadId });
    return shell;
  });
  const get = Effect.fn("ViewCodeGoals.get")(function* (threadId: ThreadId) {
    return (yield* read(threadId)).viewcodeGoal ?? null;
  });
  const dispatch = Effect.fn("ViewCodeGoals.dispatch")(function* (
    threadId: ThreadId,
    update: { readonly viewcodeGoal?: ThreadGoal | null; readonly debugMode?: boolean },
  ) {
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`viewcode:goal:${uuid}`),
        threadId,
        ...update,
      })
      .pipe(Effect.mapError((cause) => new ThreadGoalStoreError({ threadId, cause })));
  });
  const set = Effect.fn("ViewCodeGoals.set")(function* (threadId: ThreadId, input: GoalUpdate) {
    const current = yield* get(threadId);
    if (input.objective === undefined && input.paused !== undefined && current === null)
      return yield* new ThreadGoalMissingError({ threadId });
    if (input.objective === undefined && input.paused === undefined) return current;
    const objective =
      input.objective === null
        ? null
        : input.objective === undefined
          ? current?.objective
          : yield* decodeObjective(input.objective.trim()).pipe(
              Effect.mapError(() => new ThreadGoalInvalidObjectiveError({ threadId })),
            );
    const now = DateTime.formatIso(yield* DateTime.now);
    const pausedAt =
      input.paused === undefined
        ? (current?.pausedAt ?? null)
        : input.paused
          ? (current?.pausedAt ?? now)
          : null;
    const next =
      objective === null || objective === undefined
        ? null
        : { objective, pausedAt, updatedAt: now };
    if (current?.objective === next?.objective && current?.pausedAt === next?.pausedAt)
      return current;
    yield* dispatch(threadId, { viewcodeGoal: next });
    return yield* get(threadId);
  });
  const getDebug = Effect.fn("ViewCodeGoals.getDebug")(function* (threadId: ThreadId) {
    return (yield* read(threadId)).debugMode === true;
  });
  const setDebug = Effect.fn("ViewCodeGoals.setDebug")(function* (
    threadId: ThreadId,
    enabled: boolean,
  ) {
    if ((yield* getDebug(threadId)) !== enabled) yield* dispatch(threadId, { debugMode: enabled });
    return yield* getDebug(threadId);
  });
  return ViewCodeGoals.of({ get, set, getDebug, setDebug });
});
export const layer = Layer.effect(ViewCodeGoals, make);
