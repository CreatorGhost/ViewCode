// ponytail: mirrors `@t3tools/client-runtime/agent-session-import` from the web PR (#119);
// import it from there once that lands and delete this copy.
import type { AgentSessionHiddenReason, AgentSessionSummary } from "@t3tools/contracts";

export function sessionKey(
  session: Pick<AgentSessionSummary, "providerInstanceId" | "providerSessionId">,
): string {
  return `${session.providerInstanceId}\0${session.providerSessionId}`;
}

/** Newest first, with folded-away sessions split out for the "Show hidden" toggle. */
export function partitionImportableSessions<T extends AgentSessionSummary>(
  sessions: ReadonlyArray<T>,
) {
  // A fresh array, sorted in place: Hermes (mobile) has no `toSorted`.
  const sorted = [...sessions].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt),
  );
  return {
    visible: sorted.filter((session) => !session.hidden),
    hidden: sorted.filter((session) => session.hidden),
  };
}

export type SelectAllState = "none" | "some" | "all";

type SelectableSession = Pick<
  AgentSessionSummary,
  "providerInstanceId" | "providerSessionId" | "alreadyImported"
>;

/**
 * What the reader's ticks select among the rows on screen: the shown sessions that are ticked and
 * not imported already, and whether that is none, some or all of the ones that could be. A ticked
 * session that "Show hidden" folded away is not selected until it is shown again, so the import
 * count always matches the ticks the reader can see.
 */
export function importSelection<T extends SelectableSession>(
  shown: ReadonlyArray<T>,
  checked: ReadonlySet<string>,
): { readonly selected: ReadonlyArray<T>; readonly state: SelectAllState } {
  const selectable = shown.filter((session) => !session.alreadyImported);
  const selected = selectable.filter((session) => checked.has(sessionKey(session)));
  const state: SelectAllState =
    selected.length === 0 ? "none" : selected.length === selectable.length ? "all" : "some";
  return { selected, state };
}

/**
 * "Select all" over the shown rows: from all it clears them, from none or some it ticks every one
 * not imported already. Ticks on rows that are not shown are kept as they were.
 */
export function toggleSelectAll(
  shown: ReadonlyArray<SelectableSession>,
  checked: ReadonlySet<string>,
): ReadonlySet<string> {
  const keys = shown
    .filter((session) => !session.alreadyImported)
    .map((session) => sessionKey(session));
  const next = new Set(checked);
  if (importSelection(shown, checked).state === "all") {
    for (const key of keys) next.delete(key);
  } else {
    for (const key of keys) next.add(key);
  }
  return next;
}

export const HIDDEN_REASON_LABELS: Record<AgentSessionHiddenReason, string> = {
  subagent: "Sub-agent",
  "agent-message": "Started by another agent",
  internal: "Internal run",
  "too-short": "Too short",
  "no-user-text": "No message of yours",
  "in-viewcode": "Already in ViewCode",
  "in-t3code": "Also in T3 Code",
};
