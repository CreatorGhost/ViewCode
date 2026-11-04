import type { ScopedThreadRef } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ shell: null as EnvironmentThreadShell | null }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => state.shell }));

import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { useAskInSideChat } from "./useAskInSideChat";

const parent = scopeThreadRef(EnvironmentId.make("parent-environment"), ThreadId.make("parent"));
const other = scopeThreadRef(EnvironmentId.make("other-environment"), ThreadId.make("other"));
let renderer: ReactTestRenderer | null = null;
let ask: ReturnType<typeof useAskInSideChat> = null;

function Harness(props: { source: ScopedThreadRef | null }) {
  const result = useAskInSideChat(props.source);
  useLayoutEffect(() => {
    ask = result;
  }, [result]);
  return null;
}

function show(source: ScopedThreadRef | null, kind: "sidechat" | null = null) {
  state.shell =
    source === null
      ? null
      : ({
          environmentId: source.environmentId,
          id: source.threadId,
          source: { kind },
        } as EnvironmentThreadShell);
  act(() => {
    if (renderer) renderer.update(<Harness source={source} />);
    else renderer = create(<Harness source={source} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSidechatDockStore.setState({ byParentKey: {} });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  ask = null;
  vi.unstubAllGlobals();
});

describe("selection side chats on native thread shells", () => {
  it("quotes into the source environment's dock and consumes the prefill once", () => {
    show(parent);
    act(() => ask?.("a selected\nanswer"));
    const dock = selectSidechatDock(useSidechatDockStore.getState().byParentKey, parent);
    expect(dock.open).toBe(true);
    expect(dock.prefill).toBe("> a selected answer\n\n");
    expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, other).open).toBe(false);
    expect(useSidechatDockStore.getState().consumePrefill(parent)).toBe(dock.prefill);
    expect(useSidechatDockStore.getState().consumePrefill(parent)).toBeNull();
  });

  it("changes the destination when the selected thread changes", () => {
    show(parent);
    show(other);
    act(() => ask?.("other answer"));
    expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, parent).open).toBe(
      false,
    );
    expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, other).prefill).toBe(
      "> other answer\n\n",
    );
  });

  it("withholds the action for drafts, missing threads and side chats themselves", () => {
    show(null);
    expect(ask).toBeNull();
    show(parent, "sidechat");
    expect(ask).toBeNull();
    expect(selectSidechatDock(useSidechatDockStore.getState().byParentKey, parent).open).toBe(
      false,
    );
  });
});
