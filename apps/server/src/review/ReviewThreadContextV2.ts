import {
  type OrchestrationThreadActivity,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ReviewActivityStore from "./ReviewActivityStoreV2.ts";

export const read = Effect.fn("ReviewThreadContextV2.read")(function* (
  threadId: ThreadId,
  kinds?: ReadonlyArray<string>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const thread = yield* projections.getThreadShell(threadId);
  if (thread === null)
    return Option.none<
      OrchestrationV2ThreadShell & {
        readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
      }
    >();
  return Option.some({ ...thread, activities: yield* activities.list(threadId, kinds) });
});
