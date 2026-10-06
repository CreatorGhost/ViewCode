import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findStalledTurns,
  nextStallCheckAt,
  recordTurnStallEvent,
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

const fold = (events: ReadonlyArray<readonly [ProviderRuntimeEvent, number]>) =>
  events.reduce<TurnStallState>((state, [e, at]) => recordTurnStallEvent(state, e, at), new Map());

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
    const done = recordTurnStallEvent(running, event("item.completed", tool), 10);
    expect(nextStallCheckAt(done)).toBe(10 + TURN_STALL_TIMEOUT_MS);
  });

  it("never fires while the turn waits on the user", () => {
    const waiting = fold([
      [event("turn.started"), 0],
      [event("request.opened", { requestId: "req-1" }), 0],
    ]);
    expect(findStalledTurns(waiting, TURN_STALL_ACTIVE_TOOL_TIMEOUT_MS * 10)).toEqual([]);
    expect(nextStallCheckAt(waiting)).toBeNull();
    const answered = recordTurnStallEvent(
      waiting,
      event("request.resolved", { requestId: "req-1" }),
      50,
    );
    expect(nextStallCheckAt(answered)).toBe(50 + TURN_STALL_TIMEOUT_MS);
  });

  it("stops tracking once the turn ends, and ignores events for untracked threads", () => {
    const ended = fold([
      [event("turn.started"), 0],
      [event("turn.completed"), 5],
    ]);
    expect(ended.size).toBe(0);
    expect(recordTurnStallEvent(new Map(), event("content.delta"), 0).size).toBe(0);
  });
});
