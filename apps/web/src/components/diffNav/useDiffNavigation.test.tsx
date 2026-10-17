import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ editable: false, terminal: false }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: null }));
vi.mock("../../lib/editableFocus", () => ({ isEditableFocused: () => state.editable }));
vi.mock("../../lib/terminalFocus", () => ({ isTerminalFocused: () => state.terminal }));
import { SplitPaneContext } from "../../splitView/SplitPaneContext";
import { useDiffNavigation } from "./useDiffNavigation";

let renderer: ReactTestRenderer | undefined;
let navigation: ReturnType<typeof useDiffNavigation> | undefined;
const reveal = vi.fn();
const mac = /mac/i.test(globalThis.navigator?.platform ?? "");
function Harness({ focused, paths }: { focused: boolean; paths: ReadonlyArray<string> }) {
  return (
    <SplitPaneContext value={{ focused, onSwap: () => {}, onClose: () => {} }}>
      <Panel paths={paths} />
    </SplitPaneContext>
  );
}
function Panel({ paths }: { paths: ReadonlyArray<string> }) {
  const current = useDiffNavigation(paths, reveal);
  useEffect(() => {
    navigation = current;
  }, [current]);
  return null;
}
function press(key: string, mod = false, prevented = false) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key,
    ctrlKey: mod && !mac,
    metaKey: mod && mac,
    altKey: true,
    shiftKey: false,
  });
  if (prevented) event.preventDefault();
  act(() => window.dispatchEvent(event));
  return event;
}
function mount(focused: boolean, paths: ReadonlyArray<string> = ["a.ts", "b.ts"]) {
  act(() => {
    renderer = create(<Harness focused={focused} paths={paths} />);
  });
}
beforeEach(() => {
  state.editable = false;
  state.terminal = false;
  reveal.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  navigation = undefined;
  vi.unstubAllGlobals();
});

it("handles next/previous file only in the focused pane and respects already handled keys", () => {
  mount(false);
  press("ArrowDown");
  expect(reveal).not.toHaveBeenCalled();
  act(() => renderer?.update(<Harness focused paths={["a.ts", "b.ts"]} />));
  expect(press("ArrowDown").defaultPrevented).toBe(true);
  expect(reveal).toHaveBeenLastCalledWith("a.ts");
  press("ArrowUp");
  expect(reveal).toHaveBeenLastCalledWith("b.ts");
  press("ArrowDown", false, true);
  expect(reveal).toHaveBeenCalledTimes(2);
});

it("does not step changed files while the user edits text", () => {
  mount(true);
  state.editable = true;
  press("ArrowDown");
  expect(reveal).not.toHaveBeenCalled();
});

it("opens the file picker with the configured shortcut, except in a terminal", () => {
  mount(true);
  state.terminal = true;
  press("f", true);
  expect(navigation?.jumpOpen).toBe(false);
  state.terminal = false;
  press("f", true);
  expect(navigation?.jumpOpen).toBe(true);
  act(() => navigation?.setJumpOpen(false));
  expect(navigation?.jumpOpen).toBe(false);
});

it("uses refreshed native file lists and selected picker position for subsequent stepping", () => {
  mount(true);
  act(() => renderer?.update(<Harness focused paths={["new-a.ts", "new-b.ts", "new-c.ts"]} />));
  act(() => navigation?.jump("new-b.ts"));
  press("ArrowDown");
  expect(reveal.mock.calls).toEqual([["new-b.ts"], ["new-c.ts"]]);
});
