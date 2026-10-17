import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findStalledTurns,
  nextStallCheckAt,
  recordTurnStallEvent,
  sessionStillOnTurn,
  TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS,
  TURN_STALL_TIMEOUT_MS,
  type TurnStallState,
} from "./turnStall.ts";

const THREAD = "thread-1";
const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({
    eventId: EventId.make(`e-${type}`),
    provider: "claudeAgent",
    threadId: ThreadId.make(THREAD),
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-10-07T00:00:00.000Z",
    type,
    payload: {},
    ...extra,
  }) as unknown as ProviderRuntimeEvent;

const fold = (events: ReadonlyArray<readonly [ProviderRuntimeEvent, number]>) => {
  const state: TurnStallState = new Map();
  for (const [e, at] of events) recordTurnStallEvent(state, e, at);
  return state;
};

describe("turn stall tracking", () => {
  it("flags a turn that went silent past the deadline", () => {
    const state = fold([
      [event("turn.started"), 0],
      [event("content.delta"), 1_000],
    ]);
    expect(findStalledTurns(state, 1_000 + TURN_STALL_TIMEOUT_MS - 1)).toEqual([]);
    expect(findStalledTurns(state, 1_000 + TURN_STALL_TIMEOUT_MS)).toEqual([
      { threadId: THREAD, turnId: "turn-1", silentForMs: TURN_STALL_TIMEOUT_MS },
    ]);
  });

  it("gives a running tool the longer deadline until it completes", () => {
    const tool = { itemId: "item-1", payload: { itemType: "command_execution" } };
    const running = fold([
      [event("turn.started"), 0],
      [event("item.started", tool), 0],
    ]);
    expect(findStalledTurns(running, TURN_STALL_TIMEOUT_MS)).toEqual([]);
    expect(nextStallCheckAt(running)).toBe(TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS);
    expect(recordTurnStallEvent(running, event("item.completed", tool), 10)).toBe(true);
    expect(nextStallCheckAt(running)).toBe(10 + TURN_STALL_TIMEOUT_MS);
  });

  it("never fires while the turn waits on the user", () => {
    const waiting = fold([
      [event("turn.started"), 0],
      [event("request.opened", { requestId: "req-1" }), 0],
    ]);
    expect(findStalledTurns(waiting, TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS * 10)).toEqual([]);
    expect(nextStallCheckAt(waiting)).toBeNull();
    expect(
      recordTurnStallEvent(waiting, event("request.resolved", { requestId: "req-1" }), 50),
    ).toBe(true);
    expect(nextStallCheckAt(waiting)).toBe(50 + TURN_STALL_TIMEOUT_MS);
  });

  it("stops tracking once the turn ends, and ignores events for untracked threads", () => {
    const ended = fold([
      [event("turn.started"), 0],
      [event("turn.completed"), 5],
    ]);
    expect(ended.size).toBe(0);
    const untracked: TurnStallState = new Map();
    expect(recordTurnStallEvent(untracked, event("content.delta"), 0)).toBe(false);
    expect(untracked.size).toBe(0);
  });

  it("asks for a re-plan only when the earliest deadline can move earlier", () => {
    const state: TurnStallState = new Map();
    const tool = { itemId: "item-1", payload: { itemType: "command_execution" } };
    expect(recordTurnStallEvent(state, event("turn.started"), 0)).toBe(true);
    const entry = state.get(THREAD);
    // A delta moves the deadline later in place, without waking the loop.
    expect(recordTurnStallEvent(state, event("content.delta"), 500)).toBe(false);
    expect(state.get(THREAD)).toBe(entry);
    expect(nextStallCheckAt(state)).toBe(500 + TURN_STALL_TIMEOUT_MS);
    expect(recordTurnStallEvent(state, event("item.started", tool), 600)).toBe(true);
    expect(recordTurnStallEvent(state, event("item.started", tool), 700)).toBe(false);
    // Completing an item that is not an open tool changes no deadline.
    expect(recordTurnStallEvent(state, event("item.completed", { itemId: "msg-1" }), 800)).toBe(
      false,
    );
    expect(recordTurnStallEvent(state, event("item.completed", tool), 900)).toBe(true);
    expect(recordTurnStallEvent(state, event("turn.completed"), 1_000)).toBe(true);
    expect(recordTurnStallEvent(state, event("turn.completed"), 1_100)).toBe(false);
  });
});

describe("sessionStillOnTurn", () => {
  it("only confirms the stall for the turn the projection still shows active", () => {
    expect(sessionStillOnTurn({ activeTurnId: "turn-1" }, "turn-1")).toBe(true);
    expect(sessionStillOnTurn({ activeTurnId: "turn-2" }, "turn-1")).toBe(false);
    expect(sessionStillOnTurn({ activeTurnId: null }, "turn-1")).toBe(false);
    expect(sessionStillOnTurn(null, "turn-1")).toBe(false);
    expect(sessionStillOnTurn(undefined, undefined)).toBe(false);
    expect(sessionStillOnTurn({ activeTurnId: "turn-9" }, undefined)).toBe(true);
  });
});
