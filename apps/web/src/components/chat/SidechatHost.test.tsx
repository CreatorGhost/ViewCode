import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./SidechatDock", () => ({ SidechatDock: () => null }));
vi.mock("../../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { SplitPaneContext } from "../../splitView/SplitPaneContext";
import { SidechatHost } from "./SidechatHost";

const thread = {
  environmentId: EnvironmentId.make("env"),
  id: ThreadId.make("parent"),
  source: { kind: null },
} as unknown as EnvironmentThreadShell;
const parentRef = scopeThreadRef(thread.environmentId, thread.id);

let renderer: ReactTestRenderer | null = null;

function mount(focused: boolean, target: EnvironmentThreadShell | null = thread) {
  act(() => {
    renderer = create(
      <SplitPaneContext value={{ focused, onSwap: () => {}, onClose: () => {} }}>
        <SidechatHost
          thread={target}
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          markdownCwd={undefined}
        />
      </SplitPaneContext>,
    );
  });
}

const mac = /mac/i.test(globalThis.navigator?.platform ?? "");

/** The default side chat shortcut, mod+shift+/. */
function pressSidechatShortcut() {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "?",
    code: "Slash",
    ctrlKey: !mac,
    metaKey: mac,
    shiftKey: true,
    altKey: false,
    repeat: false,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

const dockOpen = () =>
  selectSidechatDock(useSidechatDockStore.getState().byParentKey, parentRef).open;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  useSidechatDockStore.setState({ byParentKey: {} });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("SidechatHost in split view", () => {
  it("does not open nested side chats or a dock for a draft", () => {
    mount(true, { ...thread, source: { ...thread.source, kind: "sidechat" } });
    pressSidechatShortcut();
    expect(dockOpen()).toBe(false);
    act(() => renderer?.unmount());
    mount(true, null);
    pressSidechatShortcut();
    expect(dockOpen()).toBe(false);
  });

  it("only the focused pane answers the side chat shortcut", () => {
    mount(false);
    pressSidechatShortcut();
    expect(dockOpen()).toBe(false);

    act(() => renderer?.unmount());
    mount(true);
    pressSidechatShortcut();
    expect(dockOpen()).toBe(true);
  });
});
