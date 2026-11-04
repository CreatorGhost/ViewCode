import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";

export const ThreadKind = Schema.Literals(["sidechat", "orchestrator"]);
export type ThreadKind = typeof ThreadKind.Type;

export const THREAD_GOAL_MAX_CHARS = 2000;
export const ThreadGoalObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_GOAL_MAX_CHARS),
);
export const ThreadGoal = Schema.Struct({
  objective: ThreadGoalObjective,
  pausedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ViewCodeThreadSettings = Schema.Struct({
  kind: Schema.optional(Schema.NullOr(ThreadKind)),
  viewcodeGoal: Schema.optional(Schema.NullOr(ThreadGoal)),
  debugMode: Schema.optional(Schema.Boolean),
});
export const ViewCodeThreadMetadata = Schema.Struct({
  ...ViewCodeThreadSettings.fields,
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  viewcodeMessageFork: Schema.optional(
    Schema.Struct({
      sourceThreadId: ThreadId,
      messageId: MessageId,
      turnItemId: TurnItemId,
    }),
  ),
});
export type ViewCodeThreadMetadata = typeof ViewCodeThreadMetadata.Type;
