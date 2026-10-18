// @effect-diagnostics nodeBuiltinImport:off - executes the installed web list initialization in a synchronous VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

type Target = {
  index: number;
  viewPosition: number;
  contentOffset?: number;
  preserveForFooterLayout?: boolean;
};

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function initializeInitialScrollOnMount(");
  const end = source.indexOf("function handleInitialScrollDataChange(", start);
  if (start < 0 || end < start)
    throw new Error("Installed list initialization function is missing");
  const state = {
    didFinishInitialScroll: false,
    initialScroll: { index: 9, viewPosition: 1 } as Target | undefined,
    initialScrollSession: undefined as { kind: string } | undefined,
    scroll: 720,
  };
  const ctx = { state };
  const setInitialScrollTarget = vi.fn((_context: typeof ctx, target: Target) => {
    state.initialScroll = target;
  });
  const startBootstrapInitialScrollOnMount = vi.fn();
  const finishInitialScroll = vi.fn();
  const setInitialRenderState = vi.fn();
  const initialize = NodeVM.runInNewContext(
    `${source.slice(start, end)}\ninitializeInitialScrollOnMount`,
    {
      setInitialScrollTarget,
      startBootstrapInitialScrollOnMount,
      finishInitialScroll,
      setInitialRenderState,
    },
  ) as (context: typeof ctx, options: typeof defaults) => void;
  const defaults = {
    alwaysDispatchInitialScroll: false,
    dataLength: 10,
    hasFooterComponent: false,
    initialContentOffset: 0,
    initialScrollAtEnd: true,
    useBootstrapInitialScroll: true,
  };
  return {
    state,
    setInitialScrollTarget,
    startBootstrapInitialScrollOnMount,
    finishInitialScroll,
    setInitialRenderState,
    initialize: (options: Partial<typeof defaults> = {}) =>
      initialize(ctx, { ...defaults, ...options }),
  };
}

describe.each(["react.js", "react.mjs"])("installed web list Activity reconnect (%s)", (bundle) => {
  it.each(["end", "offset"])(
    "preserves a completed %s position when the mount effect reconnects",
    (kind) => {
      const list = createList(bundle);
      list.state.didFinishInitialScroll = true;
      list.state.initialScrollSession = { kind };
      const target = list.state.initialScroll;
      list.initialize({ hasFooterComponent: true });
      expect(list.state.initialScroll).toBe(target);
      expect(list.state.scroll).toBe(720);
      expect(list.setInitialScrollTarget).not.toHaveBeenCalled();
      expect(list.startBootstrapInitialScrollOnMount).not.toHaveBeenCalled();
      expect(list.finishInitialScroll).not.toHaveBeenCalled();
      expect(list.setInitialRenderState).not.toHaveBeenCalled();
    },
  );

  it("still initializes a cold end target including footer preservation", () => {
    const list = createList(bundle);
    list.initialize({ hasFooterComponent: true });
    expect(list.state.initialScroll).toEqual({
      index: 9,
      viewPosition: 1,
      contentOffset: 0,
      preserveForFooterLayout: true,
    });
    expect(list.startBootstrapInitialScrollOnMount).toHaveBeenCalledExactlyOnceWith(
      { state: list.state },
      { initialScrollAtEnd: true, target: list.state.initialScroll },
    );
    expect(list.setInitialRenderState).not.toHaveBeenCalled();
  });

  it("still finishes a cold non-bootstrap index target", () => {
    const list = createList(bundle);
    list.initialize({ initialScrollAtEnd: false, useBootstrapInitialScroll: false });
    expect(list.finishInitialScroll).toHaveBeenCalledExactlyOnceWith(
      { state: list.state },
      { resolvedOffset: 0 },
    );
    expect(list.startBootstrapInitialScrollOnMount).not.toHaveBeenCalled();
  });

  it("still reveals an untargeted cold origin", () => {
    const list = createList(bundle);
    list.state.initialScroll = undefined;
    list.initialize({ initialScrollAtEnd: false });
    expect(list.setInitialRenderState).toHaveBeenCalledExactlyOnceWith(
      { state: list.state },
      { didInitialScroll: true },
    );
    expect(list.startBootstrapInitialScrollOnMount).not.toHaveBeenCalled();
  });

  it("leaves a cold offset session to its native offset dispatcher", () => {
    const list = createList(bundle);
    list.state.initialScrollSession = { kind: "offset" };
    list.initialize({ initialContentOffset: 120 });
    expect(list.state.initialScroll?.contentOffset).toBe(120);
    expect(list.startBootstrapInitialScrollOnMount).not.toHaveBeenCalled();
    expect(list.finishInitialScroll).not.toHaveBeenCalled();
    expect(list.setInitialRenderState).not.toHaveBeenCalled();
  });

  it("allows native fresh-data reset to initialize again", () => {
    const list = createList(bundle);
    list.state.didFinishInitialScroll = true;
    list.initialize();
    list.state.didFinishInitialScroll = false;
    list.state.initialScroll = { index: 2, viewPosition: 1 };
    list.initialize();
    expect(list.startBootstrapInitialScrollOnMount).toHaveBeenCalledTimes(1);
    expect(list.startBootstrapInitialScrollOnMount).toHaveBeenLastCalledWith(
      { state: list.state },
      { initialScrollAtEnd: true, target: list.state.initialScroll },
    );
  });
});
