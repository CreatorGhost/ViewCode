import {
  EventId,
  ThreadId,
  type AgentSessionImportSource,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

export function importedThreadId(
  source: Pick<AgentSessionImportSource, "provider" | "providerInstanceId" | "providerSessionId">,
): ThreadId {
  return ThreadId.make(
    `import:${source.provider === "t3code" ? "t3code" : source.providerInstanceId}:${source.providerSessionId}`,
  );
}
export interface ImportedParentLink {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
}

/** Metadata-only second pass keeps transcript parsing streamed while parents can arrive last. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  return Effect.fn("ViewCodeImportedLineage.link")(function* (
    projectId: ProjectId,
    links: ReadonlyArray<ImportedParentLink>,
  ) {
    const pending = new Map(links.map((link) => [link.childThreadId, link.parentThreadId]));
    let progressed = true;
    while (progressed && pending.size > 0) {
      progressed = false;
      for (const [childId, parentId] of pending) {
        if (childId === parentId) {
          pending.delete(childId);
          continue;
        }
        if (pending.has(parentId)) continue;
        pending.delete(childId);
        progressed = true;
        yield* executor.withLock(
          childId,
          Effect.gen(function* () {
            const parent = yield* orchestrator.getThreadRecords(parentId, []).pipe(Effect.option);
            const child = yield* orchestrator.getThreadRecords(childId, []).pipe(Effect.option);
            if (Option.isNone(parent) || Option.isNone(child)) return;
            const lead = parent.value.thread;
            const current = child.value.thread;
            if (
              lead.projectId !== projectId ||
              current.projectId !== projectId ||
              current.historyOrigin !== "v1_import" ||
              current.lineage.parentThreadId !== null ||
              lead.lineage.rootThreadId === childId ||
              current.deletedAt !== null ||
              lead.deletedAt !== null
            )
              return;
            const payload = {
              ...current,
              parentThreadId: parentId,
              lineage: {
                parentThreadId: parentId,
                rootThreadId: lead.lineage.rootThreadId,
                relationshipToParent: "subagent" as const,
              },
            };
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`agent-session-import:v2:lineage:${childId}:${parentId}`),
                  type: "thread.metadata-updated",
                  threadId: childId,
                  occurredAt: yield* DateTime.now,
                  payload,
                },
              ],
            });
          }),
        );
      }
    }
  });
});
