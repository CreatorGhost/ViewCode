import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { TerminalManager } from "../terminal/Manager.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Cleanup that goes with archiving a thread: archive removes it from view, so
 * its provider session stops and its terminals close. The client archive
 * (`ws.ts`) and side chat expiry both use this, so an archive from either
 * path leaves nothing running behind.
 */
export interface ArchiveCleanupTarget {
  readonly threadId: ThreadId;
  readonly stopSession: boolean;
}

/**
 * The thread being archived plus every descendant the decider's cascade
 * archives with it (child agents and side chats). Walks through children that
 * are already archived, since an active grandchild below one is archived too.
 */
export function archiveCleanupTargets(
  active: ReadonlyArray<OrchestrationThreadShell>,
  archived: ReadonlyArray<OrchestrationThreadShell>,
  rootThreadId: ThreadId,
): ReadonlyArray<ArchiveCleanupTarget> {
  const threads = [...active, ...archived];
  const byParent = new Map<string, OrchestrationThreadShell[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = byParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else byParent.set(thread.parentThreadId, [thread]);
  }
  const root = active.find((thread) => thread.id === rootThreadId);
  if (root === undefined) return [];
  const tree = [root];
  const seen = new Set<string>([root.id]);
  for (let index = 0; index < tree.length; index += 1) {
    for (const child of byParent.get(tree[index]!.id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      tree.push(child);
    }
  }
  return tree
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => ({
      threadId: thread.id,
      stopSession: thread.session !== null && thread.session.status !== "stopped",
    }));
}

/**
 * Read before dispatching the archive, while the threads are still active.
 * Best-effort on purpose: an archive must not fail because this read blipped,
 * so a failed read cleans up only the archived thread's terminals.
 */
export const readArchiveCleanupTargets = (
  projections: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot" | "getArchivedShellSnapshot">,
  threadId: ThreadId,
): Effect.Effect<ReadonlyArray<ArchiveCleanupTarget>> =>
  Effect.all([projections.getShellSnapshot(), projections.getArchivedShellSnapshot()]).pipe(
    Effect.map(([active, archived]) =>
      archiveCleanupTargets(active.threads, archived.threads, threadId),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to read thread session state before session-stop check", {
        threadId,
        cause,
      }).pipe(Effect.as([{ threadId, stopSession: false }])),
    ),
  );

type SessionStopCommand = Extract<OrchestrationCommand, { readonly type: "thread.session.stop" }>;

/** Run after the archive landed: stop each live session, then close each thread's terminals. */
export const cleanUpArchivedThreads = <E, R>(input: {
  readonly archiveCommandId: CommandId;
  readonly rootThreadId: ThreadId;
  readonly targets: ReadonlyArray<ArchiveCleanupTarget>;
  readonly dispatch: (command: SessionStopCommand) => Effect.Effect<unknown, E, R>;
  readonly terminals: Pick<TerminalManager["Service"], "close">;
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    for (const archived of input.targets) {
      if (archived.stopSession) {
        yield* Effect.gen(function* () {
          yield* input.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make(
              archived.threadId === input.rootThreadId
                ? `session-stop-for-archive:${input.archiveCommandId}`
                : `session-stop-for-archive:${input.archiveCommandId}:${archived.threadId}`,
            ),
            threadId: archived.threadId,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to stop provider session during archive", {
              threadId: archived.threadId,
              cause,
            }),
          ),
        );
      }
      yield* input.terminals.close({ threadId: archived.threadId }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close thread terminals after archive", {
            threadId: archived.threadId,
            error: error.message,
          }),
        ),
      );
    }
  });
