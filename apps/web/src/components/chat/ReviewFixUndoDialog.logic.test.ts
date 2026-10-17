import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { undoReviewFixes } from "./ReviewFixUndoDialog.logic";
import { threadRef, threadKey, otherThreadKey, makeThread } from "./reviewFixUndo.test.fixtures";

let requestId = CommandId.make("not-dispatched");
function observeThread() {
  const atom = Atom.make({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(makeThread()) });
  vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(atom);
  return atom;
}
function updateThread(
  atom: ReturnType<typeof observeThread>,
  projection: OrchestrationV2ThreadProjection,
) {
  appAtomRegistry.set(atom, { ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(projection) });
}
function rolledBack() {
  const projection = makeThread({ messages: [], checkpoints: [] });
  return {
    ...projection,
    runs: projection.runs.map((run) => ({ ...run, status: "rolled_back" as const })),
  };
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
    const result = undoReviewFixes(threadRef, async (id) => {
      requestId = id;
      accepted.resolve();
      return AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
    });
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    await accepted.promise;
    await Promise.resolve();
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    updateThread(atom, makeThread({ messages: [] }));
    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    updateThread(atom, rolledBack());
    await expect(result).resolves.toBe(true);
    expect([...useComposerDraftStore.getState().rewindingThreadKeys]).toEqual([otherThreadKey]);
  });

  it("releases the lock and reports a rollback failure after acceptance", async () => {
    const atom = observeThread();
    const accepted = deferred<void>();
    const result = undoReviewFixes(threadRef, async (id) => {
      requestId = id;
      accepted.resolve();
      return AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
    });
    const rejection = expect(result).rejects.toThrow("Provider history unavailable");
    await accepted.promise;
    const projection = makeThread();
    updateThread(atom, {
      ...projection,
      thread: {
        ...projection.thread,
        rollbackFailure: { requestId, message: "Provider history unavailable" },
      },
    });
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
      updateThread(atom, rolledBack());
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
