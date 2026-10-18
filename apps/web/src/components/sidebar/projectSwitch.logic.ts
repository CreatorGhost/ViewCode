import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

type SwitchCandidateThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "archivedAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "lineage"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "kind">;
};

export const projectRefKey = (ref: {
  readonly environmentId: string;
  readonly projectId: string;
}) => `${ref.environmentId}:${ref.projectId}`;

/**
 * The thread to show after switching to a project folder: the one most recently viewed this
 * session, else an open tab, else the most recently active lead thread. Null means the folder
 * has no threads, so the caller opens a new one there.
 */
export function pickProjectSwitchThread<T extends SwitchCandidateThread>(input: {
  readonly memberProjectKeys: ReadonlySet<string>;
  readonly threads: ReadonlyArray<T>;
  readonly recentThreadKeys: ReadonlyArray<string>;
  readonly openTabKeys: ReadonlyArray<string>;
}): T | null {
  const byKey = new Map<string, T>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.source.kind === "sidechat") continue;
    if (!input.memberProjectKeys.has(projectRefKey(thread))) continue;
    byKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
  }
  for (const key of [...input.recentThreadKeys, ...input.openTabKeys]) {
    const thread = byKey.get(key);
    if (thread) return thread;
  }
  const activity = (thread: T) => thread.latestUserMessageAt ?? thread.updatedAt;
  let latest: T | null = null;
  for (const thread of byKey.values()) {
    if (thread.lineage.parentThreadId !== null) continue;
    if (!latest || activity(thread) > activity(latest)) latest = thread;
  }
  return latest;
}
