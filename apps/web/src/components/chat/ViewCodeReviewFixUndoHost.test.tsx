import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeThread, threadRef, threadKey } from "./reviewFixUndo.test.fixtures";

const controls = vi.hoisted(() => ({
  canOperate: true,
  capable: true,
  focused: true,
  command: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: makeThread() }),
  useServerConfigs: () =>
    new Map([
      [
        threadRef.environmentId,
        { environment: { capabilities: { reviewFixUndo: controls.capable } } },
      ],
    ]),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => controls.canOperate }));
vi.mock("../../splitView/SplitPaneContext", () => ({
  useSplitPaneFocused: () => controls.focused,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => controls.command }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (value: unknown) => controls.toast(value) },
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  AlertDialogPopup: "div",
  AlertDialogHeader: "div",
  AlertDialogTitle: "h2",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
  AlertDialogClose: "button",
}));
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { useComposerDraftStore } from "../../composerDraftStore";
import { REVIEW_FIX_UNDO_OPEN_EVENT } from "./ReviewFixUndoDialog";
import {
  ViewCodeReviewFixUndoHost,
  ViewCodeReviewFixUndoButton,
} from "./ViewCodeReviewFixUndoHost";

let renderer: ReactTestRenderer;
let state: ReturnType<typeof stateAtom>;
function stateAtom() {
  return Atom.make({ ...EMPTY_ENVIRONMENT_THREAD_STATE, data: Option.some(makeThread()) });
}
function content() {
  return (
    <ViewCodeReviewFixUndoHost threadRef={threadRef}>
      <ViewCodeReviewFixUndoButton runOrdinal={1} disabled={false} />
      <ViewCodeReviewFixUndoButton runOrdinal={2} disabled={false} />
    </ViewCodeReviewFixUndoHost>
  );
}
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.includes(label))!;
}
function rollback() {
  const projection = makeThread({ messages: [], checkpoints: [] });
  appAtomRegistry.set(state, {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    data: Option.some({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "rolled_back" as const })),
    }),
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  controls.canOperate = true;
  controls.capable = true;
  controls.focused = true;
  controls.command.mockReset();
  controls.toast.mockReset();
  state = stateAtom();
  vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state);
  useComposerDraftStore.setState({ rewindingThreadKeys: new Set() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useComposerDraftStore.setState({ rewindingThreadKeys: new Set() });
});

it("confirms the native fix rollback and keeps sending locked until its projection arrives", async () => {
  let accepted = () => {};
  const dispatched = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  controls.command.mockImplementation(async () => {
    accepted();
    return AsyncResult.success({ turnCount: 0, undoneTurns: 1 });
  });
  act(() => {
    renderer = create(content());
  });
  expect(
    renderer.root
      .findAllByType("button")
      .filter((node) => node.children.includes("Undo review fixes")),
  ).toHaveLength(1);
  act(() => button("Undo review fixes").props.onClick());
  expect(renderer.root.findByProps({ role: "dialog" })).toBeDefined();
  await act(async () => {
    button("Undo fixes").props.onClick();
    await dispatched;
  });
  expect(controls.command.mock.calls[0]?.[0]).toMatchObject({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, commandId: expect.any(String) },
  });
  expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
  expect(button("Undoing...").props.disabled).toBe(true);
  await act(async () => {
    rollback();
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(false);
});

it("keeps a failed rollback visible and releases the send lock", async () => {
  controls.command.mockRejectedValue(new Error("Checkpoint unavailable"));
  act(() => {
    renderer = create(content());
  });
  act(() => button("Undo review fixes").props.onClick());
  await act(async () => {
    button("Undo fixes").props.onClick();
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(false);
  expect(controls.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Could not undo the review fixes",
      description: "Checkpoint unavailable",
    }),
  );
});

it("routes the existing window action only to the focused permitted pane", () => {
  controls.focused = false;
  act(() => {
    renderer = create(content());
  });
  act(() => window.dispatchEvent(new Event(REVIEW_FIX_UNDO_OPEN_EVENT)));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  controls.focused = true;
  act(() => renderer.update(content()));
  act(() => window.dispatchEvent(new Event(REVIEW_FIX_UNDO_OPEN_EVENT)));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
});

it.each(["permission", "capability"])("hides undo when the server lacks %s", (reason) => {
  if (reason === "permission") controls.canOperate = false;
  else controls.capable = false;
  act(() => {
    renderer = create(content());
  });
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  act(() => window.dispatchEvent(new Event(REVIEW_FIX_UNDO_OPEN_EVENT)));
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(controls.command).not.toHaveBeenCalled();
});
