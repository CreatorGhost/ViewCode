import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { ReviewHeaderButton } from "./ReviewHeaderButton";

const threadRef = {
  environmentId: EnvironmentId.make("review-header-env"),
  threadId: ThreadId.make("review-header-thread"),
};
const otherRef = { ...threadRef, threadId: ThreadId.make("other-thread") };
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  useRightPanelStore.setState({ byThreadKey: {} });
  vi.unstubAllGlobals();
});

it("opens and closes this thread’s Review surface without losing its other tabs or another thread’s panel", () => {
  useRightPanelStore.getState().open(threadRef, "files");
  useRightPanelStore.getState().open(otherRef, "diff");
  act(() => {
    renderer = create(
      <ReviewHeaderButton
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        compact
      />,
    );
  });
  const button = () => renderer.root.findByType("button");
  expect(button().props["aria-pressed"]).toBe(false);
  act(() => button().props.onClick());
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
  expect(button().props["aria-pressed"]).toBe(true);
  expect(
    useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.map((surface) => surface.kind),
  ).toEqual(["files", "review"]);
  act(() => button().props.onClick());
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBeNull();
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherRef)).toBe("diff");
  act(() => button().props.onClick());
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
  expect(
    useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces,
  ).toHaveLength(2);
});
