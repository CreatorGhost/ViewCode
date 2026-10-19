import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Native input refs let this suite exercise toolbar state without a browser layout engine.
vi.mock("../ui/input-group", async () => {
  const { createElement } = await import("react");
  return {
    InputGroup: ({ children, ...props }: ComponentProps<"div">) => createElement("div", props, children),
    InputGroupAddon: ({ children, ...props }: ComponentProps<"span">) => createElement("span", props, children),
    InputGroupInput: (props: ComponentProps<"input">) => createElement("input", props),
  };
});

import { ThreadFindBar } from "./ThreadFindBar";

let renderer: ReactTestRenderer | null = null;
const focus = vi.fn();
const select = vi.fn();
const next = vi.fn();
const previous = vi.fn();

const props = (): ComponentProps<typeof ThreadFindBar> => ({
  open: true,
  query: "needle",
  matchCount: 2,
  status: null,
  onRetry: () => {},
  activeIndex: 0,
  focusRequestId: 1,
  onQueryChange: () => {},
  onNext: next,
  onPrevious: previous,
  onClose: () => {},
});

function render(input: ComponentProps<typeof ThreadFindBar>) {
  act(() => {
    const element = <ThreadFindBar {...input} />;
    if (renderer) renderer.update(element);
    else renderer = create(element, { createNodeMock: () => ({ focus, select }) });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("ThreadFindBar with v2 server search", () => {
  it("preserves focus and selection while streamed results refresh until explicitly refocused", () => {
    const initial = props();
    render(initial);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    for (let matchCount = 3; matchCount < 12; matchCount++) render({ ...initial, matchCount });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(previous).not.toHaveBeenCalled();
    render({ ...initial, focusRequestId: 2 });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("navigates Enter and Shift-Enter without consuming IME composition", () => {
    render(props());
    const input = renderer!.root.findByType("input");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const key = (shiftKey = false, isComposing = false, keyCode = 13) => {
      act(() => input.props.onKeyDown({ key: "Enter", shiftKey, nativeEvent: { isComposing, keyCode }, preventDefault, stopPropagation }));
    };
    key(false, true);
    key(false, false, 229);
    expect(next).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    key();
    key(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(stopPropagation).toHaveBeenCalledTimes(2);
  });
});
