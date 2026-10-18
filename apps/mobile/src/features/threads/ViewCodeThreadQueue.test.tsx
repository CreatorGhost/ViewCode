// @vitest-environment jsdom
import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { ChatAttachmentId, EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import type { QueuedRunEdit } from "../../state/queued-run-edit";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  workflow: null as ThreadQueueWorkflowState | null,
  granted: true,
  reorder: vi.fn<(_input: unknown) => Promise<void>>(async () => {}),
  cancel: vi.fn<(_input: unknown) => Promise<void>>(async () => {}),
  resume: vi.fn<(_input: unknown) => Promise<void>>(async () => {}),
  editing: null as QueuedRunEdit | null,
  beginEdit: vi.fn<(_key: string, edit: QueuedRunEdit) => void>(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "permission" ? state.granted : state.workflow),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "permission" ? state.granted : state.workflow),
  },
}));
vi.mock("../../state/session", () => ({ environmentScopeAtom: () => "permission" }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { queueWorkflowAtom: () => "queue" },
  threadEnvironment: {
    cancelQueuedRun: { name: "cancel", permissionAtom: () => "permission" },
    reorderQueuedRun: { name: "reorder" },
    resumeThreadQueue: { name: "resume" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: ({ name }: { name: "cancel" | "resume" | "reorder" }) => state[name],
}));
vi.mock("../../state/queued-run-edit", () => ({
  beginQueuedRunEdit: (key: string, edit: QueuedRunEdit) => state.beginEdit(key, edit),
  useQueuedRunEdit: () => state.editing,
  getQueuedRunEdit: () => state.editing,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    onPressAction,
  }: {
    actions: ReadonlyArray<{ id: string; title: string; attributes: { disabled: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {actions.map((action) => (
        <button
          key={action.id}
          disabled={action.attributes.disabled}
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));

import { ViewCodeThreadQueue } from "./ViewCodeThreadQueue";

const target = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
const rows = (texts: string[]) =>
  texts.map((text, index) => ({
    run: {
      id: RunId.make(`run-${text}`),
      ordinal: index,
      status: "queued",
    } as ThreadQueueWorkflowState["queuedRuns"][number]["run"],
    messageId: MessageId.make(`message-${text}`),
    text,
    attachments: [
      {
        type: "file" as const,
        id: ChatAttachmentId.make("file"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    ],
  }));
let root: Root | null = null;
let container: HTMLDivElement;
const render = () => act(() => root!.render(<ViewCodeThreadQueue target={target} />));
const button = (label: string, index = 0) =>
  [...container.querySelectorAll("button")].filter(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  )[index]!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.granted = true;
  state.editing = null;
  state.beginEdit.mockImplementation((_key, edit) => {
    state.editing = edit;
  });
  state.workflow = {
    activeRun: null,
    queuedRuns: rows(["first", "second", "third"]),
    isHeld: false,
    canReorder: true,
    canPromoteToSteer: false,
  };
  container = document.createElement("div");
  root = createRoot(container);
  render();
  act(() => button("Show shared queue").click());
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

it("renders remote queue edits and removal without keeping a device-owned row", () => {
  expect(container.textContent).toContain("first");
  expect(container.textContent).toContain("notes.txt");
  state.workflow = { ...state.workflow!, queuedRuns: rows(["edited on desktop", "second"]) };
  render();
  expect(container.textContent).not.toContain("first");
  expect(container.textContent).toContain("edited on desktop");
  expect(container.textContent).toContain("2 queued");
  state.workflow = { ...state.workflow, queuedRuns: [] };
  render();
  expect(container.textContent).toBe("");
});

it("opens a separate edit with the accepted message and attachments", () => {
  act(() => {
    button("Edit", 1).click();
    button("Edit", 1).click();
  });
  expect(state.beginEdit).toHaveBeenCalledExactlyOnceWith("remote:thread", {
    runId: "run-second",
    messageId: "message-second",
    originalText: "second",
    existingAttachments: rows(["second"])[0]!.attachments,
  });
  expect(state.cancel).not.toHaveBeenCalled();
});

it("moves a row before its next neighbour and cancels the exact server row", async () => {
  await act(async () => button("Move down").click());
  expect(state.reorder).toHaveBeenCalledExactlyOnceWith({
    ...target,
    input: { threadId: target.threadId, runId: "run-first", beforeRunId: "run-third" },
  });
  await act(async () => button("Cancel message", 1).click());
  expect(state.cancel).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { threadId: target.threadId, runId: "run-second" },
  });
});

it("disables denied mutations and rechecks grants and row ownership at press time", () => {
  state.granted = false;
  act(() => button("Edit").click());
  expect(state.beginEdit).not.toHaveBeenCalled();
  render();
  expect(button("Edit").disabled).toBe(true);
  expect(button("Cancel message").disabled).toBe(true);
  state.granted = true;
  render();
  state.workflow = { ...state.workflow!, queuedRuns: rows(["second"]) };
  act(() => button("Edit").click());
  expect(state.beginEdit).not.toHaveBeenCalled();
});

it("resumes a held server queue exactly once while its receipt is pending", async () => {
  let finish!: () => void;
  state.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  state.workflow = { ...state.workflow!, isHeld: true };
  render();
  act(() => {
    button("Resume shared queue").click();
    button("Resume shared queue").click();
  });
  expect(state.resume).toHaveBeenCalledExactlyOnceWith({
    ...target,
    input: { threadId: target.threadId },
  });
  expect(button("Resume shared queue").disabled).toBe(true);
  expect(button("Cancel message").disabled).toBe(true);
  await act(async () => finish());
  expect(button("Resume shared queue").disabled).toBe(false);
});

it("keeps order controls unavailable when the native provider cannot reorder", () => {
  state.workflow = { ...state.workflow!, canReorder: false, isHeld: true };
  state.granted = false;
  render();
  expect(button("Move up", 1).disabled).toBe(true);
  expect(button("Move down").disabled).toBe(true);
  expect(button("Resume shared queue").disabled).toBe(true);
  expect(container.textContent).toContain("Held");
  expect(state.resume).not.toHaveBeenCalled();
});
