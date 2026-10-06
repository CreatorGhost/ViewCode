import {
  OrchestrationDispatchCommandError,
  type ThreadForkSource,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { sliceForkMessages } from "./ThreadFork.ts";

/**
 * Fills a client's `forkFrom` with the source title and the sliced history.
 * Fails the dispatch when the source thread or message is gone.
 */
export const resolveThreadFork = Effect.fn("resolveThreadFork")(function* (input: {
  readonly forkThreadId: ThreadId;
  readonly forkFrom: ThreadForkSource;
}) {
  const projection = yield* ProjectionSnapshotQuery;
  const source = yield* projection.getThreadDetailById(input.forkFrom.threadId, {
    activityKinds: [],
  });
  if (Option.isNone(source)) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Thread '${input.forkFrom.threadId}' was not found, so it cannot be forked.`,
    });
  }
  const messages = sliceForkMessages(
    source.value.messages,
    input.forkFrom.messageId,
    input.forkThreadId,
  );
  if (messages === null) {
    return yield* new OrchestrationDispatchCommandError({
      message: `Message '${input.forkFrom.messageId}' is not in thread '${input.forkFrom.threadId}'.`,
    });
  }
  return {
    threadId: input.forkFrom.threadId,
    messageId: input.forkFrom.messageId,
    sourceTitle: source.value.title,
    messages,
  } satisfies ThreadForkSource;
});
