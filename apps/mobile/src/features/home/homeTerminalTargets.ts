import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "./homeThreadList";

/** Terminals on mobile always belong to a thread, so Home opens one through its project's latest thread. */
export interface HomeTerminalTarget {
  readonly scopeKey: string;
  readonly projectTitle: string;
  /** Scoped keys of the projects the scope groups, to match a Home project filter. */
  readonly projectKeys: ReadonlySet<string>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}

/**
 * One target per project scope that has a live thread, most recently active
 * first. The target thread is the scope's newest non-archived thread.
 */
export function buildHomeTerminalTargets(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}): ReadonlyArray<HomeTerminalTarget> {
  const scopeKeyByProjectKey = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope.key] as const,
      ),
    ),
  );
  const latestByScope = new Map<
    string,
    { readonly thread: EnvironmentThreadShell; readonly timestamp: number }
  >();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const scopeKey = scopeKeyByProjectKey.get(
      scopedProjectKey(thread.environmentId, thread.projectId),
    );
    if (scopeKey === undefined) continue;
    const timestamp = getThreadSortTimestamp(thread, "updated_at");
    const current = latestByScope.get(scopeKey);
    if (current === undefined || timestamp > current.timestamp) {
      latestByScope.set(scopeKey, { thread, timestamp });
    }
  }

  return (
    input.scopes
      .flatMap((scope) => {
        const latest = latestByScope.get(scope.key);
        if (latest === undefined) return [];
        return [
          {
            timestamp: latest.timestamp,
            target: {
              scopeKey: scope.key,
              projectTitle: scope.title,
              projectKeys: new Set(
                scope.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
              ),
              environmentId: latest.thread.environmentId,
              threadId: latest.thread.id,
              threadTitle: latest.thread.title,
            } satisfies HomeTerminalTarget,
          },
        ];
      })
      // .sort() on the flatMapped copy: Hermes doesn't ship .toSorted().
      .sort(
        (a, b) =>
          b.timestamp - a.timestamp || a.target.projectTitle.localeCompare(b.target.projectTitle),
      )
      .map((entry) => entry.target)
  );
}

/** The target for the Home project filter, or null when no single project is selected. */
export function findSelectedTerminalTarget(
  targets: ReadonlyArray<HomeTerminalTarget>,
  selectedProjectKey: string | null,
): HomeTerminalTarget | null {
  if (selectedProjectKey === null) return null;
  return (
    targets.find(
      (target) =>
        target.scopeKey === selectedProjectKey || target.projectKeys.has(selectedProjectKey),
    ) ?? null
  );
}
