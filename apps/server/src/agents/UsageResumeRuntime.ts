import {
  type ModelSelection,
  type OrchestrationThreadActivity,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ActivityStore from "../review/ReviewActivityStoreV2.ts";
import type { RateLimitSignal } from "./usageResetTime.ts";

export interface UsageResumeThread {
  readonly id: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly providerInstanceId: ProviderInstanceId;
  readonly archived: boolean;
  readonly child: boolean;
}

export type UsageResumeEvent =
  | {
      readonly type: "failed";
      readonly threadId: ThreadId;
      readonly error: string;
      readonly request?: string;
      readonly recorded?: RateLimitSignal;
      readonly usageLimit?: boolean;
    }
  | { readonly type: "ready"; readonly threadId: ThreadId }
  | { readonly type: "signal"; readonly threadId: ThreadId; readonly detail: unknown }
  | { readonly type: "turn-start"; readonly threadId: ThreadId; readonly messageId: string }
  | { readonly type: "model"; readonly threadId: ThreadId; readonly modelSelection: ModelSelection }
  | { readonly type: "removed"; readonly threadId: ThreadId };

/** The scheduler sees durable v2 state through this boundary; it has no v1 event dependency. */
export class UsageResumeRuntime extends Context.Service<
  UsageResumeRuntime,
  {
    readonly getThread: (threadId: ThreadId) => Effect.Effect<UsageResumeThread | undefined>;
    readonly append: (activity: {
      readonly threadId: ThreadId;
      readonly activity: OrchestrationThreadActivity;
      readonly commandId: import("@t3tools/contracts").CommandId;
    }) => Effect.Effect<void>;
    readonly events: Effect.Effect<Stream.Stream<UsageResumeEvent>, never, Scope.Scope>;
  }
>()("t3/agents/UsageResumeRuntime") {}

function usageResumeEvents(
  event: OrchestrationV2DomainEvent,
  shell?: OrchestrationV2ThreadShell | null,
): ReadonlyArray<UsageResumeEvent> {
  switch (event.type) {
    case "run.created":
      return [
        { type: "turn-start", threadId: event.threadId, messageId: event.payload.userMessageId },
      ];
    case "run.updated": {
      if (event.payload.status === "completed")
        return [{ type: "ready", threadId: event.threadId }];
      if (event.payload.status !== "failed" || !shell?.lastError) return [];
      const reset = shell.usageLimitResetAt ? Date.parse(shell.usageLimitResetAt) : NaN;
      return [
        {
          type: "failed",
          threadId: event.threadId,
          error: shell.lastError,
          request: event.payload.id,
          usageLimit: shell.lastErrorClass === "usage_limit",
          ...(Number.isFinite(reset) ? { recorded: { resetsAt: reset, windows: [] } } : {}),
        },
      ];
    }
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return [
        { type: "model", threadId: event.threadId, modelSelection: event.payload.modelSelection },
      ];
    case "thread.archived":
    case "thread.deleted":
      return [{ type: "removed", threadId: event.threadId }];
    default:
      return [];
  }
}

export const layer = Layer.effect(
  UsageResumeRuntime,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const activity = yield* ActivityStore.ReviewActivityStoreV2;
    return UsageResumeRuntime.of({
      getThread: (threadId) =>
        threads.getThreadShell(threadId).pipe(
          Effect.map((shell) =>
            shell === null
              ? undefined
              : {
                  id: shell.id,
                  modelSelection: shell.modelSelection,
                  providerInstanceId: shell.providerInstanceId,
                  archived: shell.archivedAt !== null || shell.deletedAt !== null,
                  child:
                    shell.lineage.relationshipToParent === "subagent" ||
                    (shell.parentThreadId != null &&
                      shell.kind !== "sidechat" &&
                      shell.lineage.relationshipToParent === null),
                },
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      append: (input) =>
        activity.append(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not record usage resume activity.", {
              threadId: input.threadId,
              cause,
            }),
          ),
        ),
      events: Effect.succeed(
        threads.streamDomainEvents.pipe(
          Stream.mapEffect((event) =>
            event.type === "run.updated" && event.payload.status === "failed"
              ? threads.getThreadShell(event.threadId).pipe(
                  Effect.map((shell) => usageResumeEvents(event, shell)),
                  Effect.orElseSucceed(() => []),
                )
              : Effect.succeed(usageResumeEvents(event)),
          ),
          Stream.flatMap(Stream.fromIterable),
          Stream.catchCause((cause) =>
            Stream.fromEffect(
              Effect.logWarning("Usage resume event stream stopped.", { cause }),
            ).pipe(Stream.drain),
          ),
        ),
      ),
    });
  }),
);
