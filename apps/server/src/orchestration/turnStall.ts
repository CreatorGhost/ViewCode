import { isToolLifecycleItemType, type ProviderRuntimeEvent } from "@t3tools/contracts";

/**
 * Pure bookkeeping for `TurnStallWatchdog`: which thread has a turn in flight,
 * when its provider last said anything, and whether it is waiting on the user.
 *
 * A provider stream can stay open while sending nothing but keep-alives (a
 * throttled gateway, a dropped upstream), and the adapter never sees an error.
 * Without a deadline the thread shows "Working" forever. Grok has its own
 * adapter-level deadline; this covers every provider from the event stream.
 */

/** No event at all for this long ends the turn. Long enough for slow reasoning. */
export const TURN_STALL_TIMEOUT_MS = 10 * 60 * 1_000;
/** A tool call can run silently much longer (builds, test suites). */
export const TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS = 30 * 60 * 1_000;

export interface TurnStallEntry {
  readonly turnId: string | undefined;
  readonly lastActivityAt: number;
  readonly openTools: ReadonlySet<string>;
  /** Approvals and questions block on the user, never on the provider. */
  readonly waitingOnUser: ReadonlySet<string>;
}

export type TurnStallState = ReadonlyMap<string, TurnStallEntry>;

const empty = (turnId: string | undefined, at: number): TurnStallEntry => ({
  turnId,
  lastActivityAt: at,
  openTools: new Set(),
  waitingOnUser: new Set(),
});

const withItem = (set: ReadonlySet<string>, id: string | undefined, add: boolean) => {
  if (id === undefined) return set;
  const next = new Set(set);
  if (add) next.add(id);
  else next.delete(id);
  return next;
};

/** Folds one provider event into the tracker. Unknown threads only start on `turn.started`. */
export function recordTurnStallEvent(
  state: TurnStallState,
  event: ProviderRuntimeEvent,
  at: number,
): TurnStallState {
  const threadId = String(event.threadId);
  const current = state.get(threadId);
  const next = new Map(state);

  switch (event.type) {
    case "turn.started":
      next.set(threadId, empty(event.turnId, at));
      return next;
    case "turn.completed":
    case "turn.aborted":
    case "session.exited":
      next.delete(threadId);
      return next;
    default:
      break;
  }
  if (current === undefined) return state;

  let entry: TurnStallEntry = { ...current, lastActivityAt: at };
  switch (event.type) {
    case "item.started":
      if (isToolLifecycleItemType(event.payload.itemType)) {
        entry = { ...entry, openTools: withItem(entry.openTools, event.itemId, true) };
      }
      break;
    case "item.completed":
      entry = { ...entry, openTools: withItem(entry.openTools, event.itemId, false) };
      break;
    case "request.opened":
    case "user-input.requested":
      entry = { ...entry, waitingOnUser: withItem(entry.waitingOnUser, event.requestId, true) };
      break;
    case "request.resolved":
    case "user-input.resolved":
      entry = { ...entry, waitingOnUser: withItem(entry.waitingOnUser, event.requestId, false) };
      break;
    default:
      break;
  }
  next.set(threadId, entry);
  return next;
}

export interface StalledTurn {
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly silentForMs: number;
}

/** Threads whose turn has been silent past its deadline, oldest silence first. */
export function findStalledTurns(state: TurnStallState, now: number): ReadonlyArray<StalledTurn> {
  const stalled: StalledTurn[] = [];
  for (const [threadId, entry] of state) {
    if (entry.waitingOnUser.size > 0) continue;
    const limit =
      entry.openTools.size > 0 ? TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS : TURN_STALL_TIMEOUT_MS;
    const silentForMs = now - entry.lastActivityAt;
    if (silentForMs >= limit) stalled.push({ threadId, turnId: entry.turnId, silentForMs });
  }
  return stalled.toSorted((a, b) => b.silentForMs - a.silentForMs);
}

/** The earliest moment any tracked turn could stall, or null when none can. */
export function nextStallCheckAt(state: TurnStallState): number | null {
  let next: number | null = null;
  for (const entry of state.values()) {
    if (entry.waitingOnUser.size > 0) continue;
    const limit =
      entry.openTools.size > 0 ? TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS : TURN_STALL_TIMEOUT_MS;
    const at = entry.lastActivityAt + limit;
    if (next === null || at < next) next = at;
  }
  return next;
}

export function describeStall(silentForMs: number): string {
  const minutes = Math.round(silentForMs / 60_000);
  return `The provider sent nothing for ${minutes} minutes, so this turn was stopped. Send your message again to retry.`;
}
