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
  TooltipPopup: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
vi.mock("../../keybindings", () => ({ shortcutLabelForCommand: () => "⌘⇧S" }));

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { ViewCodeHeaderThreadActions } from "./ViewCodeHeaderThreadActions";

const threadRef = {
  environmentId: EnvironmentId.make("header-env"),
  threadId: ThreadId.make("header-thread"),
};
const otherRef = { ...threadRef, environmentId: EnvironmentId.make("other-env") };
let renderer: ReactTestRenderer;
const toggleTerminal = vi.fn();
function mount(overrides: Partial<Parameters<typeof ViewCodeHeaderThreadActions>[0]> = {}) {
  act(() => {
    renderer = create(
      <ViewCodeHeaderThreadActions
        threadRef={threadRef}
        isServerThread
        isSidechat={false}
        keybindings={[]}
        terminalAvailable
        terminalOpen={false}
        onToggleTerminal={toggleTerminal}
        {...overrides}
      />,
    );
  });
}
function click(label: string) {
  act(() => renderer.root.findByProps({ "aria-label": label }).props.onClick());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toggleTerminal.mockReset();
  useRightPanelStore.setState({ byThreadKey: {} });
  useSidechatDockStore.setState({ byParentKey: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  useRightPanelStore.setState({ byThreadKey: {} });
  useSidechatDockStore.setState({ byParentKey: {} });
  vi.unstubAllGlobals();
});

it("uses native terminal, dock and Review toggles scoped to the selected environment", () => {
  useRightPanelStore.getState().open(otherRef, "files");
  useSidechatDockStore.getState().open(otherRef);
  mount();
  click("Toggle terminal drawer");
  expect(toggleTerminal).toHaveBeenCalledOnce();
  click("Side chat");
  expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, threadRef).open).toBe(
    true,
  );
  click("Review");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
  click("Side chat");
  click("Review");
  expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, threadRef).open).toBe(
    false,
  );
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBeNull();
  expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, otherRef).open).toBe(true);
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherRef)).toBe("files");
});

it("keeps draft affordances visible without creating dock or panel state", () => {
  mount({ isServerThread: false });
  click("Side chat");
  click("Review");
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  const explanations = renderer.root.findAllByType("aside").flatMap((node) => node.children);
  expect(explanations).toContain("Send a message to start this thread before opening a side chat.");
  expect(explanations).toContain(
    "Send a message to start this thread before viewing review findings.",
  );
  click("Toggle terminal drawer");
  expect(toggleTerminal).toHaveBeenCalledOnce();
});

it("honors denied permissions even when an old click handler is invoked", () => {
  mount({
    disabled: true,
    disabledReason: "This connection is read-only",
    terminalAvailable: false,
  });
  click("Toggle terminal drawer");
  click("Side chat");
  click("Review");
  expect(toggleTerminal).not.toHaveBeenCalled();
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("keeps Review reachable inside side chats without offering nested side chats", () => {
  mount({ isSidechat: true, terminalAvailable: false });
  expect(renderer.root.findAllByProps({ "aria-label": "Side chat" })).toHaveLength(0);
  click("Toggle terminal drawer");
  expect(toggleTerminal).not.toHaveBeenCalled();
  click("Review");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
});

it("uses the separate terminal permission when orchestration actions are read-only", () => {
  mount({ disabled: true, terminalAvailable: true });
  click("Toggle terminal drawer");
  click("Side chat");
  click("Review");
  expect(toggleTerminal).toHaveBeenCalledOnce();
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("opens draft panels only through the supplied record preparation callbacks", () => {
  const onOpenSidechat = vi.fn();
  const onOpenReview = vi.fn();
  mount({ isServerThread: false, onOpenSidechat, onOpenReview });
  click("Side chat");
  click("Review");
  expect(onOpenSidechat).toHaveBeenCalledOnce();
  expect(onOpenReview).toHaveBeenCalledOnce();
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("does not enable the other draft action when only one preparation callback exists", () => {
  const onOpenReview = vi.fn();
  mount({ isServerThread: false, onOpenReview });
  click("Side chat");
  click("Review");
  expect(onOpenReview).toHaveBeenCalledOnce();
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
});

it.each(["busy", "disabled"] as const)("blocks draft callbacks while %s", (flag) => {
  const onOpenSidechat = vi.fn();
  const onOpenReview = vi.fn();
  mount({ isServerThread: false, onOpenSidechat, onOpenReview, [flag]: true });
  click("Side chat");
  click("Review");
  expect(onOpenSidechat).not.toHaveBeenCalled();
  expect(onOpenReview).not.toHaveBeenCalled();
  expect(useSidechatDockStore.getState().byParentKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});

it("allows an existing server thread to use the explicit native panel opener", () => {
  const onOpenReview = vi.fn(() => useRightPanelStore.getState().open(threadRef, "review"));
  mount({ onOpenReview });
  click("Review");
  expect(onOpenReview).toHaveBeenCalledOnce();
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
  click("Review");
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
    "review",
  );
});
