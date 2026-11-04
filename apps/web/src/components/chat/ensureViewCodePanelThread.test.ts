import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_MODEL,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../../providerInstances";
import { makeEnsureViewCodePanelThread } from "./ensureViewCodePanelThread";

const environmentId = EnvironmentId.make("panel-environment");
const projectId = ProjectId.make("panel-project");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("panel-thread"));
const draftId = DraftId.make("panel-draft");
const now = "2026-10-18T10:00:00.000Z";
function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}
beforeEach(() => {
  reset();
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
      threadId: threadRef.threadId,
      branch: "feature-base",
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
});
afterEach(reset);
function harness() {
  let saved: { projectId: ProjectId; deletedAt: string | null } | null = null;
  const create = vi.fn<Parameters<typeof makeEnsureViewCodePanelThread>[0]["create"]>(async () => {
    saved = { projectId, deletedAt: null };
    return AsyncResult.success(undefined);
  });
  const canOperate = vi.fn(() => true);
  const waitForThread = vi.fn(async () => saved !== null);
  const ensure = makeEnsureViewCodePanelThread({
    create,
    readThread: () => saved,
    waitForThread,
    canOperate,
    now: () => now,
  });
  const submissionLock = { current: false };
  return {
    ensure,
    create,
    waitForThread,
    canOperate,
    submissionLock,
    input: { threadRef, draftId, submissionLock },
    setSaved: (value: typeof saved) => {
      saved = value;
    },
  };
}

describe("explicit draft panel materialization", () => {
  it("only creates a native record with the all-off metadata seed and leaves provider choice unset", async () => {
    const test = harness();
    const store = useComposerDraftStore.getState();
    const composer = store.getComposerDraft(draftId);
    expect(
      await test.ensure({ ...test.input, modelSelection: NO_PROVIDER_MODEL_SELECTION }),
    ).toEqual(threadRef);
    expect(test.create).toHaveBeenCalledOnce();
    const request = test.create.mock.calls[0]?.[0];
    expect(request?.input).toMatchObject({
      threadId: threadRef.threadId,
      projectId,
      title: "New thread",
      modelSelection: { instanceId: "codex", model: DEFAULT_MODEL },
      branch: "feature-base",
      worktreePath: null,
    });
    expect(request?.input).not.toHaveProperty("initialMessage");
    expect(request?.input).not.toHaveProperty("bootstrap");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(composer);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      promotedTo: threadRef,
      envMode: "worktree",
      startFromOrigin: true,
    });
    expect(test.submissionLock.current).toBe(false);
  });

  it("preserves prompt, file/upload ownership, model options, goal/debug and workspace until first send", async () => {
    const test = harness();
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Do not send this yet");
    store.setModelSelection(draftId, {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "sonnet",
      options: [{ id: "effort", value: "high" }],
    });
    store.setDraftThreadContext(draftId, { goal: "Preserve the migration", debugMode: true });
    const file = new File(["unsent"], "notes.txt", { type: "text/plain" });
    store.addFiles(draftId, [
      {
        type: "file",
        id: "panel-upload",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ]);
    const composer = useComposerDraftStore.getState().getComposerDraft(draftId);
    await test.ensure({
      ...test.input,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
    });
    expect(test.create.mock.calls[0]?.[0].input).toMatchObject({
      modelSelection: composer?.modelSelectionByProvider[ProviderInstanceId.make("claude-work")],
      viewcodeGoal: { objective: "Preserve the migration", pausedAt: null, updatedAt: now },
      debugMode: true,
      branch: "feature-base",
      worktreePath: null,
    });
    const after = useComposerDraftStore.getState();
    expect(after.getComposerDraft(draftId)).toBe(composer);
    expect(after.getComposerDraft(threadRef)).toBe(composer);
    expect(after.getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      startFromOrigin: true,
      goal: "Preserve the migration",
      debugMode: true,
    });
    expect(after.getComposerDraft(draftId)?.files[0]?.file).toBe(file);
  });

  it("deduplicates concurrent Sidechat/Review clicks and holds the same first-send lock", async () => {
    const test = harness();
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.create.mockImplementation(async () => {
      await receipt;
      test.setSaved({ projectId, deletedAt: null });
      return AsyncResult.success(undefined);
    });
    const first = test.ensure(test.input);
    const second = test.ensure(test.input);
    expect(second).toBe(first);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.submissionLock.current).toBe(true);
    useComposerDraftStore.getState().setPrompt(draftId, "Typed while saving");
    release();
    expect(await first).toEqual(threadRef);
    expect(await second).toEqual(threadRef);
    expect(test.submissionLock.current).toBe(false);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Typed while saving",
    );
    await test.ensure(test.input);
    expect(test.create).toHaveBeenCalledOnce();
  });

  it("does not write without permission or race an in-flight first send", async () => {
    const test = harness();
    test.canOperate.mockReturnValue(false);
    expect(await test.ensure(test.input)).toBeNull();
    test.canOperate.mockReturnValue(true);
    test.submissionLock.current = true;
    expect(await test.ensure(test.input)).toBeNull();
    expect(test.create).not.toHaveBeenCalled();
    expect(test.submissionLock.current).toBe(true);
  });

  it("keeps the draft on a rejected create and retries with the same idempotent native command", async () => {
    const test = harness();
    const original = useComposerDraftStore.getState().getDraftSession(draftId);
    test.create.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("rejected"))));
    await expect(test.ensure(test.input)).rejects.toThrow("rejected");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(original);
    expect(test.submissionLock.current).toBe(false);
    await test.ensure(test.input);
    expect(test.create.mock.calls[0]?.[0].input.commandId).toBe(
      test.create.mock.calls[1]?.[0].input.commandId,
    );
    expect(test.create.mock.calls[0]?.[0].input.threadId).toBe(
      test.create.mock.calls[1]?.[0].input.threadId,
    );
  });

  it("refuses a stale environment/thread association or a removed draft", async () => {
    const test = harness();
    expect(
      await test.ensure({
        ...test.input,
        threadRef: scopeThreadRef(EnvironmentId.make("other-server"), threadRef.threadId),
      }),
    ).toBeNull();
    useComposerDraftStore.getState().clearDraftThread(draftId);
    expect(await test.ensure(test.input)).toBeNull();
    expect(test.create).not.toHaveBeenCalled();
  });
});
