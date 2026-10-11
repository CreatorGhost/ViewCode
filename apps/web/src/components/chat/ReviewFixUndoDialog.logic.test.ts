import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import type { Thread } from "../../types";
import { undoReviewFixes } from "./ReviewFixUndoDialog.logic";

const threadRef = {
  environmentId: EnvironmentId.make("undo-environment"),
  threadId: ThreadId.make("undo-thread"),
};
const threadKey = scopedThreadKey(threadRef);
const otherThreadKey = scopedThreadKey({ ...threadRef, threadId: ThreadId.make("other-thread") });
const now = "2026-10-11T00:00:00.000Z";
const fixTurnId = TurnId.make("fix-turn");
const fixStarted = {
  id: EventId.make("fix-started"),
  kind: REVIEW_FIX_STARTED_ACTIVITY_KIND,
  tone: "info" as const,
  summary: "Review fix started",
  payload: { reviewThreadId: "review", turnCountBefore: 0, timelineBypass: true },
  turnId: null,
  createdAt: now,
};

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadRef.threadId,
    environmentId: threadRef.environmentId,
    projectId: ProjectId.make("undo-project"),
    title: "Fix thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [
      {
        id: MessageId.make("fix-message"),
        role: "user",
        text: "Fix the findings",
        turnId: fixTurnId,
        createdAt: now,
        updatedAt: now,
        streaming: false,
      },
    ],
    proposedPlans: [],
    activities: [fixStarted],
    checkpoints: [
      {
        turnId: fixTurnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/t3/checkpoints/1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: now,
      },
    ],
    pullRequests: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function observeThread() {
  const atom = Atom.make<Thread | null>(makeThread());
  vi.spyOn(environmentThreadDetails, "detailAtom").mockReturnValue(atom);
  return atom;
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("review-fix undo rewind lock", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ rewindingThreadKeys: new Set([otherThreadKey]) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useComposerDraftStore.setState({ rewindingThreadKeys: new Set() });
  });

  it("blocks sends through command acceptance and partial updates until rewind completes", async () => {
    const atom = observeThread();
    const accepted = deferred<void>();
    const result = undoReviewFixes(threadRef, async () => {
      accepted.resolve();
      return AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
    });
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    await accepted.promise;
    await Promise.resolve();
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    appAtomRegistry.set(atom, makeThread({ messages: [] }));
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    appAtomRegistry.set(atom, makeThread({ messages: [], checkpoints: [] }));
    await expect(result).resolves.toBe(true);
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("releases the lock and reports a rollback failure after acceptance", async () => {
    const atom = observeThread();
    const accepted = deferred<void>();
    const result = undoReviewFixes(threadRef, async () => {
      accepted.resolve();
      return AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
    });
    const rejection = expect(result).rejects.toThrow("Provider history unavailable");
    await accepted.promise;
    appAtomRegistry.set(
      atom,
      makeThread({
        activities: [
          fixStarted,
          {
            id: EventId.make("undo-failed"),
            kind: "checkpoint.revert.failed",
            tone: "error",
            summary: "Checkpoint revert failed",
            payload: { detail: "Provider history unavailable", turnCount: 0 },
            turnId: null,
            createdAt: now,
          },
        ],
      }),
    );
    await rejection;
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("releases the lock when dispatch fails", async () => {
    observeThread();
    await expect(
      undoReviewFixes(threadRef, async () => AsyncResult.failure(Cause.fail(new Error("Offline")))),
    ).rejects.toThrow("Offline");
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("observes completion that arrives before the command response", async () => {
    const atom = observeThread();
    const success = AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
    const response = deferred<typeof success>();
    const dispatched = deferred<void>();
    const result = undoReviewFixes(threadRef, () => {
      appAtomRegistry.set(atom, makeThread({ messages: [], checkpoints: [] }));
      dispatched.resolve();
      return response.promise;
    });
    await dispatched.promise;
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    response.resolve(success);
    await expect(result).resolves.toBe(true);
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("releases the lock without reporting an interrupted command as success", async () => {
    observeThread();
    await expect(
      undoReviewFixes(threadRef, async () => AsyncResult.failure(Cause.interrupt(1))),
    ).resolves.toBe(false);
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("leaves an existing rewind lock owned by its original operation", async () => {
    observeThread();
    useComposerDraftStore.setState({ rewindingThreadKeys: new Set([threadKey, otherThreadKey]) });
    const dispatch = vi.fn(async () => AsyncResult.success({ turnCount: 0, undoneTurns: 1 }));
    await expect(undoReviewFixes(threadRef, dispatch)).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
  });
});
