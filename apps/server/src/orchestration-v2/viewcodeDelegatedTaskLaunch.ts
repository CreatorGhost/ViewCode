import type { OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

/** Manual dispatch shares MCP's native preparation step after command acceptance. */
export const prepareManualDelegatedTask = Effect.fn("ViewCode.prepareManualDelegatedTask")(
  function* (
    command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>,
    accepted: Orchestrator.OrchestratorV2DispatchResult,
  ) {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const childIds = new Set(
      accepted.storedEvents.flatMap(({ event }) =>
        event.type === "subagent.updated" &&
        event.threadId === command.parentThreadId &&
        event.payload.origin === "app_owned" &&
        event.payload.childThreadId !== null &&
        event.payload.childThreadId !== command.parentThreadId
          ? [event.payload.childThreadId]
          : [],
      ),
    );
    for (const { event } of accepted.storedEvents) {
      if (
        event.type === "run.created" &&
        childIds.has(event.threadId) &&
        event.payload.threadId === event.threadId &&
        event.payload.workspacePreparation?.type === "worktree"
      ) {
        // Native preparation reserves the command and checks the current run,
        // so receipt retries neither create another checkout nor restart work.
        yield* launches.prepareRun({
          commandId: command.commandId,
          threadId: event.threadId,
          runId: event.payload.id,
        });
      }
    }
  },
);
