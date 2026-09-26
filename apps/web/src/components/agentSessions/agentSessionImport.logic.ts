import type {
  AgentSessionHiddenReason,
  AgentSessionSummary,
  EnvironmentId,
  OrchestrationThreadShell,
  ScopedProjectRef,
} from "@t3tools/contracts";

export const HIDDEN_REASON_LABELS: Record<AgentSessionHiddenReason, string> = {
  subagent: "Sub-agent",
  "agent-message": "Started by another agent",
  internal: "Internal run",
  "too-short": "Too short",
  "no-user-text": "No message of yours",
  "in-viewcode": "Already in ViewCode",
};

export function sessionKey(
  session: Pick<AgentSessionSummary, "providerInstanceId" | "providerSessionId">,
): string {
  return `${session.providerInstanceId}\0${session.providerSessionId}`;
}

/** Newest first, with folded-away sessions split out for the "Show hidden" toggle. */
export function partitionImportableSessions<T extends AgentSessionSummary>(
  sessions: ReadonlyArray<T>,
) {
  const sorted = sessions.toSorted((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt),
  );
  return {
    visible: sorted.filter((session) => !session.hidden),
    hidden: sorted.filter((session) => session.hidden),
  };
}

/** The importer names threads `import:<instance>:<session>`. */
export function isImportedThreadId(threadId: string): boolean {
  return threadId.startsWith("import:");
}

/** An imported thread counts as continued once it runs a turn or starts a provider session. */
export function isUntouchedImportedThread(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session">,
): boolean {
  return thread.latestTurn === null && thread.session === null;
}

/** A project's active imported threads, newest first, marked by whether anyone continued them. */
export function importedThreadsForCleanup<
  T extends Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "archivedAt" | "createdAt" | "latestTurn" | "session"
  > & { readonly environmentId: EnvironmentId },
>(threads: ReadonlyArray<T>, projectRefs: ReadonlyArray<ScopedProjectRef>) {
  const inProject = (thread: T) =>
    projectRefs.some(
      (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
    );
  return threads
    .filter(
      (thread) => isImportedThreadId(thread.id) && thread.archivedAt === null && inProject(thread),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((thread) => ({ thread, untouched: isUntouchedImportedThread(thread) }));
}
