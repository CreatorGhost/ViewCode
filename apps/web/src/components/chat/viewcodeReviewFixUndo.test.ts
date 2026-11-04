import { EventId, RunId, TurnItemId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { makeThread, fixStarted, threadRef } from "./reviewFixUndo.test.fixtures";
import {
  viewCodeReviewFixUndo,
  viewCodeReviewFixUndoUnavailableReason,
} from "./viewcodeReviewFixUndo";

it("uses the newest fix marker even when older visible history follows the current run", () => {
  const initial = makeThread();
  const old = initial.turnItems[0]!;
  if (old.type !== "system_notice") throw new Error("Expected fix notice");
  const latest = {
    ...old,
    id: TurnItemId.make("new-fix-notice"),
    viewcodeActivity: {
      ...fixStarted,
      id: EventId.make("new-fix-marker"),
      createdAt: "2026-10-12T00:00:00Z",
      payload: { ...fixStarted.payload, turnCountBefore: 1 },
    },
  };
  const projection = {
    ...initial,
    turnItems: [latest],
    runs: [...initial.runs, { ...initial.runs[0]!, id: RunId.make("second-fix"), ordinal: 2 }],
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: threadRef.threadId,
        sourceItemId: old.id,
        item: old,
      },
    ],
  };
  expect(viewCodeReviewFixUndo(projection)).toEqual({ turnCount: 1, undoneTurns: 1 });
});

it("stops offering completed rollback turns and ignores ordinary threads", () => {
  const initial = makeThread();
  expect(
    viewCodeReviewFixUndo({
      ...initial,
      runs: initial.runs.map((run) => ({ ...run, status: "rolled_back" })),
    }),
  ).toEqual({ turnCount: 0, undoneTurns: 0 });
  expect(viewCodeReviewFixUndo(makeThread({ turnItems: [] }))).toBeNull();
  expect(viewCodeReviewFixUndo(null)).toBeNull();
});

it("does not treat inherited parent review history as a fix started in the fork", () => {
  const initial = makeThread();
  const parentId = ThreadId.make("parent-fix-thread");
  const inherited = { ...initial.turnItems[0]!, threadId: parentId };
  expect(
    viewCodeReviewFixUndo({
      ...initial,
      turnItems: [],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: parentId,
          sourceItemId: inherited.id,
          item: inherited,
        },
      ],
    }),
  ).toBeNull();
});

it("blocks known root/shared workspaces including archived owners while leaving native safety authoritative", () => {
  const projection = makeThread();
  expect(
    viewCodeReviewFixUndoUnavailableReason({
      ...projection,
      thread: { ...projection.thread, worktreePath: null },
    }),
  ).toContain("root checkout");
  expect(
    viewCodeReviewFixUndoUnavailableReason(projection, [
      { id: "other", worktreePath: projection.thread.worktreePath, deletedAt: null },
    ]),
  ).toContain("Another thread");
  expect(
    viewCodeReviewFixUndoUnavailableReason(projection, [
      { id: "other", worktreePath: projection.thread.worktreePath, deletedAt: "deleted" },
    ]),
  ).toBeNull();
  expect(
    viewCodeReviewFixUndoUnavailableReason(projection, [
      { id: projection.thread.id, worktreePath: projection.thread.worktreePath, deletedAt: null },
    ]),
  ).toBeNull();
});
