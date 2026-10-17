import { CommandId, type ThreadGoal, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class ThreadGoalThreadNotFoundError extends Schema.TaggedError<ThreadGoalThreadNotFoundError>()(
  "ThreadGoalThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadGoalMissingError extends Schema.TaggedError<ThreadGoalMissingError>()(
  "ThreadGoalMissingError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return "This thread has no goal to pause or resume.";
  }
}

export class ThreadGoalStoreError extends Schema.TaggedError<ThreadGoalStoreError>()(
  "ThreadGoalStoreError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "The thread's goal could not be read or saved.";
  }
}

export type ThreadGoalError =
  | ThreadGoalThreadNotFoundError
  | ThreadGoalMissingError
  | ThreadGoalStoreError;

/**
 * A thread's goal as agents read and change it. The user's paths (web, mobile) dispatch
 * `thread.meta.update` themselves; this is the agent's path, through the MCP tools.
 */
export class ThreadGoals extends Context.Service<
  ThreadGoals,
  {
    readonly get: (threadId: ThreadId) => Effect.Effect<ThreadGoal | null, ThreadGoalError>;
    /** `objective` null clears the goal; `paused` alone pauses or resumes it. */
    readonly set: (
      threadId: ThreadId,
      input: { readonly objective?: string | null; readonly paused?: boolean },
    ) => Effect.Effect<ThreadGoal | null, ThreadGoalError>;
  }
>()("t3/orchestration/ThreadGoals") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const get = Effect.fn("ThreadGoals.get")(function* (threadId: ThreadId) {
    const shell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError((cause) => new ThreadGoalStoreError({ threadId, cause })));
    if (Option.isNone(shell)) return yield* new ThreadGoalThreadNotFoundError({ threadId });
    return shell.value.goal ?? null;
  });

  const set = Effect.fn("ThreadGoals.set")(function* (
    threadId: ThreadId,
    input: { readonly objective?: string | null; readonly paused?: boolean },
  ) {
    const current = yield* get(threadId);
    if (input.objective === undefined && input.paused !== undefined && current === null) {
      return yield* new ThreadGoalMissingError({ threadId });
    }
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:thread-goal:${uuid}`),
        threadId,
        ...(input.objective !== undefined ? { goal: input.objective } : {}),
        ...(input.paused !== undefined ? { goalPaused: input.paused } : {}),
      })
      .pipe(Effect.mapError((cause) => new ThreadGoalStoreError({ threadId, cause })));
    return yield* get(threadId);
  });

  return ThreadGoals.of({ get, set });
});

export const layer = Layer.effect(ThreadGoals, make);
