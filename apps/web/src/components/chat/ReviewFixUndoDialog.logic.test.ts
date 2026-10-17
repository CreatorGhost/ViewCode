import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CheckpointRef,
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  RunId,
  CommandId,
  type OrchestrationV2ThreadProjection,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
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

const at = DateTime.makeUnsafe(now);
const runId = RunId.make(fixTurnId);
let requestId = CommandId.make("not-dispatched");
function makeThread(overrides: Partial<OrchestrationV2ThreadProjection> = {}): OrchestrationV2ThreadProjection {
  const instanceId = ProviderInstanceId.make("codex");
  const messageId = MessageId.make("fix-message");
  return {
    thread: { id:threadRef.threadId, projectId:ProjectId.make("undo-project"),title:"Fix thread",providerInstanceId:instanceId,modelSelection:{instanceId,model:"gpt-6"},
      createdBy:"user",creationSource:"web",runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,activeProviderThreadId:null,
      lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:threadRef.threadId},forkedFrom:null,historyOrigin:"native",createdAt:at,updatedAt:at,archivedAt:null,settledOverride:null,settledAt:null,lastVisitedAt:null,deletedAt:null,
    },
    runs:[{id:runId,threadId:threadRef.threadId,ordinal:1,providerInstanceId:instanceId,modelSelection:{instanceId,model:"gpt-6"},providerThreadId:null,userMessageId:messageId,rootNodeId:null,activeAttemptId:null,status:"completed",requestedAt:at,startedAt:at,completedAt:at,checkpointId:null,contextHandoffId:null}],
    messages:[{id:messageId,threadId:threadRef.threadId,role:"user",text:"Fix the findings",createdBy:"user",creationSource:"web",attachments:[],runId,nodeId:null,createdAt:at,updatedAt:at,streaming:false}],
    turnItems:[{id: importTurnItemId,threadId:threadRef.threadId,runId:null,nodeId:null,providerThreadId:null,providerTurnId:null,nativeItemRef:null,parentItemId:null,ordinal:1,status:"completed",title:null,startedAt:at,completedAt:at,updatedAt:at,type:"system_notice",message:"Review fix started",viewcodeActivity:fixStarted}],
    checkpoints:[{id:CheckpointId.make("fix-checkpoint"),threadId:threadRef.threadId,scopeId:CheckpointScopeId.make("scope"),runId,nodeId:NodeId.make("fix-node"),parentCheckpointId:null,ordinalWithinScope:1,appRunOrdinal:1,ref:CheckpointRef.make("refs/viewcode/checkpoints/1"),status:"ready",files:[],capturedAt:at}],
    attempts:[],nodes:[],subagents:[],providerSessions:[],providerThreads:[],providerTurns:[],runtimeRequests:[],plans:[],checkpointScopes:[],contextHandoffs:[],contextTransfers:[],visibleTurnItems:[],updatedAt:at,
    ...overrides,
  };
}
const importTurnItemId = TurnItemId.make("fix-started");
function observeThread() {
  const atom = Atom.make({...EMPTY_ENVIRONMENT_THREAD_STATE,data:Option.some(makeThread())});
  vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(atom);
  return atom;
}
function updateThread(atom: ReturnType<typeof observeThread>, projection: OrchestrationV2ThreadProjection) {
  appAtomRegistry.set(atom,{...EMPTY_ENVIRONMENT_THREAD_STATE,data:Option.some(projection)});
}
function rolledBack() {
  const projection = makeThread({messages:[],checkpoints:[]});
  return {...projection,runs:projection.runs.map((run) => ({...run,status:"rolled_back" as const}))};
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
    updateThread(atom, {...projection,thread:{...projection.thread,rollbackFailure:{requestId,message:"Provider history unavailable"}}});
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
