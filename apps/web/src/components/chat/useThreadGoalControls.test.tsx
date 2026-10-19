import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

const mocks = vi.hoisted(() => ({ updateServer: vi.fn(), toast: vi.fn() }));
vi.mock("./threadGoal", async (original) => ({
  ...(await original<typeof import("./threadGoal")>()),
  useUpdateThreadGoalState: () => mocks.updateServer,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { makeEnsureViewCodePanelThread } from "./ensureViewCodePanelThread";
import { useThreadGoalControls } from "./useThreadGoalControls";

const environmentId = EnvironmentId.make("goal-pending-env");
const projectId = ProjectId.make("goal-pending-project");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("goal-pending-thread"));
const draftId = DraftId.make("goal-pending-draft");
let renderer: ReactTestRenderer | undefined;
function Controls({
  native = false,
  otherEnvironment = false,
}: {
  native?: boolean;
  otherEnvironment?: boolean;
}) {
  const session = useComposerDraftStore((state) => state.getDraftSession(draftId));
  const target = otherEnvironment
    ? { ...threadRef, environmentId: EnvironmentId.make("other-server") }
    : threadRef;
  const controls = useThreadGoalControls({
    threadKey: scopedThreadKey(target),
    environmentId: target.environmentId,
    threadId: target.threadId,
    isServerThread: native,
    serverGoal: {
      objective: "New server goal",
      pausedAt: null,
      updatedAt: "2026-10-18T12:00:00.000Z",
    },
    serverDebugMode: true,
    draftTarget: draftId,
    draftGoal: session?.goal,
    draftDebugMode: session?.debugMode,
  });
  return (
    <>
      <button aria-label="dialog-save" onClick={() => controls.saveGoal("Changed from dialog")} />
      <button
        aria-label="slash-goal"
        onClick={() => controls.applyGoalAction({ action: "set", objective: "Changed from slash" })}
      />
      <button aria-label="debug" onClick={() => controls.setDebugMode(false)} />
      <button aria-label="clear" onClick={() => controls.clearGoal()} />
      <button aria-label="pause" onClick={() => controls.setGoalPaused(true)} />
    </>
  );
}
function click(label: string) {
  act(() => renderer!.root.findByProps({ "aria-label": label }).props.onClick());
}
function mount(props: Parameters<typeof Controls>[0] = {}) {
  act(() => {
    renderer = create(<Controls {...props} />);
  });
}
function preparing(fails = false) {
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saved = false;
  const createThread = vi.fn<Parameters<typeof makeEnsureViewCodePanelThread>[0]["create"]>(
    async () => {
      await receipt;
      if (fails) return AsyncResult.failure(Cause.fail(new Error("not saved")));
      saved = true;
      return AsyncResult.success(undefined);
    },
  );
  const ensure = makeEnsureViewCodePanelThread({
    create: createThread,
    readThread: () => (saved ? { projectId, deletedAt: null } : null),
    waitForThread: async () => saved,
    canOperate: () => true,
    now: () => "2026-10-18T10:00:00.000Z",
  });
  return {
    release,
    createThread,
    result: ensure({ threadRef, draftId, submissionLock: { current: false } }),
  };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.updateServer.mockReset();
  mocks.toast.mockReset();
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {},
    draftsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
    threadId: threadRef.threadId,
  });
  store.setDraftThreadContext(draftId, { goal: "Original goal", debugMode: true });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.each(["dialog-save", "slash-goal", "debug", "clear"])(
  "holds %s edits while the record-only creation captures draft metadata",
  async (action) => {
    const pending = preparing();
    mount();
    click(action);
    const during = useComposerDraftStore.getState().getDraftSession(draftId);
    // Release before asserting so a red regression cannot strand the shared pending map.
    pending.release();
    await act(async () => {
      await pending.result;
    });
    expect(during).toMatchObject({ goal: "Original goal", debugMode: true });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Preparing thread" }),
    );
    expect(mocks.updateServer).not.toHaveBeenCalled();
    click(action);
    const after = useComposerDraftStore.getState().getDraftSession(draftId);
    // The draft store canonicalizes debug off by removing the optional flag.
    if (action === "debug") expect(after?.debugMode).toBeUndefined();
    else if (action === "clear") expect(after?.goal).toBeUndefined();
    else expect(after?.goal).not.toBe("Original goal");
  },
);

it("also gates native metadata edits after the shell arrives, without overwriting another client's newer fields", async () => {
  const pending = preparing();
  mount({ native: true });
  click("pause");
  click("debug");
  click("dialog-save");
  pending.release();
  await act(async () => {
    await pending.result;
  });
  expect(mocks.updateServer).not.toHaveBeenCalled();
  click("pause");
  expect(mocks.updateServer).toHaveBeenCalledExactlyOnceWith(environmentId, threadRef.threadId, {
    goalPaused: true,
  });
});

it("does not freeze another environment with a colliding thread id", async () => {
  const pending = preparing();
  mount({ native: true, otherEnvironment: true });
  click("debug");
  pending.release();
  await act(async () => {
    await pending.result;
  });
  expect(mocks.updateServer).toHaveBeenCalledExactlyOnceWith(
    EnvironmentId.make("other-server"),
    threadRef.threadId,
    { debugMode: false },
  );
});

it("releases the edit guard after a rejected create and leaves the draft editable", async () => {
  const pending = preparing(true);
  const settled = pending.result.catch(() => null);
  mount();
  click("dialog-save");
  pending.release();
  await act(async () => {
    await settled;
  });
  click("dialog-save");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.goal).toBe(
    "Changed from dialog",
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toBeNull();
});
