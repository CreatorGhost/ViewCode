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

/**
 * One tracked turn. Mutable on purpose: every provider delta touches
 * `lastActivityAt`, and that must stay O(1) without copying the state.
 */
export interface TurnStallEntry {
  readonly turnId: string | undefined;
  lastActivityAt: number;
  readonly openTools: Set<string>;
  /** Approvals and questions block on the user, never on the provider. */
  readonly waitingOnUser: Set<string>;
}

export type TurnStallState = Map<string, TurnStallEntry>;

const toggle = (set: Set<string>, id: string | undefined, add: boolean): boolean => {
  if (id === undefined) return false;
  if (!add) return set.delete(id);
  if (set.has(id)) return false;
  set.add(id);
  return true;
};

/**
 * Folds one provider event into the tracker in place. Unknown threads only
 * start on `turn.started`.
 *
 * Returns true when the set of deadlines changed shape (a turn started or
 * ended, a tool or a user request opened or closed), which is when the earliest
 * deadline can move earlier and the check loop must re-plan. Plain activity
 * only pushes a deadline later, so it returns false: the loop wakes at the old
 * deadline, finds nothing stalled and re-plans from there.
 */
export function recordTurnStallEvent(
  state: TurnStallState,
  event: ProviderRuntimeEvent,
  at: number,
): boolean {
  const threadId = String(event.threadId);
  switch (event.type) {
    case "turn.started":
      state.set(threadId, {
        turnId: event.turnId,
        lastActivityAt: at,
        openTools: new Set(),
        waitingOnUser: new Set(),
      });
      return true;
    case "turn.completed":
    case "turn.aborted":
    case "session.exited":
      return state.delete(threadId);
    default:
      break;
  }
  const entry = state.get(threadId);
  if (entry === undefined) return false;

  entry.lastActivityAt = at;
  switch (event.type) {
    case "item.started":
      return (
        isToolLifecycleItemType(event.payload.itemType) &&
        toggle(entry.openTools, event.itemId, true)
      );
    case "item.completed":
      return toggle(entry.openTools, event.itemId, false);
    case "request.opened":
    case "user-input.requested":
      return toggle(entry.waitingOnUser, event.requestId, true);
    case "request.resolved":
    case "user-input.resolved":
      return toggle(entry.waitingOnUser, event.requestId, false);
    default:
      return false;
  }
}

export interface StalledTurn {
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly silentForMs: number;
}

/** Threads whose turn has been silent past its deadline, oldest silence first. */
export function findStalledTurns(
  state: ReadonlyMap<string, TurnStallEntry>,
  now: number,
): ReadonlyArray<StalledTurn> {
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
export function nextStallCheckAt(state: ReadonlyMap<string, TurnStallEntry>): number | null {
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

/**
 * Whether the projected session is still on the turn the tracker holds. A
 * stall error is only worth posting for that turn; anything else means the
 * turn already ended (an event the tracker missed) or a new one replaced it.
 */
export function sessionStillOnTurn(
  session: { readonly activeTurnId: string | null } | null | undefined,
  turnId: string | undefined,
): boolean {
  const active = session?.activeTurnId ?? null;
  if (active === null) return false;
  return turnId === undefined || String(active) === turnId;
}

export function describeStall(silentForMs: number): string {
  const minutes = Math.round(silentForMs / 60_000);
  return `The provider sent nothing for ${minutes} minutes, so this turn was stopped. Send your message again to retry.`;
}
