import { EnvironmentId, PlanId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useContext, useLayoutEffect, useRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { RecentMessagesTimelines } from "./RecentMessagesTimelines";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { ChatCanvasContext } from "./ChatCanvasContext";

const lifecycle = vi.hoisted(() => ({
  starts: [] as string[],
  stops: [] as string[],
  pending: [] as Promise<void>[],
  wait: Promise.resolve(),
}));

vi.mock(import("./MessagesTimeline"), () => ({
  MessagesTimeline: function OwnedTimeline(props: Props) {
    const find = useContext(ThreadFindTimelineContext);
    const canvas = useContext(ChatCanvasContext);
    const node = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
      lifecycle.starts.push(props.routeThreadKey);
      const element = node.current!;
      const list = { getScrollableNode: () => element } as unknown as LegendListRef;
      const restore = () => element.focus();
      const reader = () => undefined;
      props.listRef.current = list;
      if (props.cancelPositionRestoreRef) props.cancelPositionRestoreRef.current = restore;
      if (find) find.findPositionReaderRef.current = reader;
      canvas?.registerTimeline(element);
      return () => {
        lifecycle.stops.push(props.routeThreadKey);
        props.listRef.current = null;
        if (props.cancelPositionRestoreRef) props.cancelPositionRestoreRef.current = null;
        if (find) find.findPositionReaderRef.current = null;
        canvas?.registerTimeline(null);
      };
    }, [props.listRef, props.cancelPositionRestoreRef, props.routeThreadKey, find, canvas]);
    return (
      <div ref={node} data-owned-thread={props.routeThreadKey}>
        <button
          onClick={() => {
            const pending = lifecycle.wait.then(() =>
              props.onForkFromRun({
                sourceThreadId: ThreadId.make(props.routeThreadKey),
                runId: RunId.make("run-owned"),
              }),
            );
            lifecycle.pending.push(pending);
          }}
        >
          Fork {props.routeThreadKey}
        </button>
      </div>
    );
  },
}));

type Props = ComponentProps<typeof RecentMessagesTimelines>;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  lifecycle.starts = [];
  lifecycle.stops = [];
  lifecycle.pending = [];
  lifecycle.wait = Promise.resolve();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  const listRef = createRef<LegendListRef | null>();
  const onForkFromRun = vi.fn(async () => {});
  const restoreRef = createRef<(() => void) | null>();
  const base: Omit<Props, "routeThreadKey"> = {
    listRef,
    cancelPositionRestoreRef: restoreRef,
    onForkFromRun,
    timelineEntries: [],
    latestRun: null,
    runs: [],
    turnDiffSummaries: [],
    isWorking: false,
    activeTurnInProgress: false,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
  const show = async (key: string, timelineEntries: Props["timelineEntries"] = []) => {
    await act(() =>
      root!.render(
        <RecentMessagesTimelines
          {...base}
          routeThreadKey={key}
          timelineEntries={timelineEntries}
        />,
      ),
    );
  };
  await show("a");
  return { show, container, listRef, restoreRef, onForkFromRun };
}

describe("recent timeline activation ownership", () => {
  it("tears down inactive effects and rejects old asynchronous actions even after reactivation", async () => {
    const view = await mount();
    let complete!: () => void;
    lifecycle.wait = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await userEvent.click(view.container.querySelector("button")!);
    await view.show("b");
    expect(lifecycle.stops).toEqual(["a"]);
    expect(lifecycle.starts).toEqual(["a", "b"]);
    expect(view.listRef.current?.getScrollableNode()?.dataset.ownedThread).toBe("b");
    await view.show("a");
    expect(lifecycle.stops).toEqual(["a", "b"]);
    expect(lifecycle.starts).toEqual(["a", "b", "a"]);
    await act(async () => {
      complete();
      await Promise.all(lifecycle.pending);
    });
    expect(view.onForkFromRun).not.toHaveBeenCalled();
    lifecycle.wait = Promise.resolve();
    const active = view.container.querySelector('[data-owned-thread="a"] button')!;
    await userEvent.click(active);
    await act(async () => {
      await Promise.all(lifecycle.pending);
    });
    expect(view.onForkFromRun).toHaveBeenCalledExactlyOnceWith({
      sourceThreadId: "a",
      runId: "run-owned",
    });
  });

  it("rejects an asynchronous action completed while its pane is inactive", async () => {
    const view = await mount();
    let complete!: () => void;
    lifecycle.wait = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await userEvent.click(view.container.querySelector("button")!);
    await view.show("b");
    const activeList = view.listRef.current;
    const activeRestore = view.restoreRef.current;
    expect(activeRestore).toBeTypeOf("function");
    await act(async () => {
      complete();
      await Promise.all(lifecycle.pending);
    });
    expect(view.onForkFromRun).not.toHaveBeenCalled();
    expect(view.listRef.current).toBe(activeList);
    expect(view.restoreRef.current).toBe(activeRestore);
    expect(view.listRef.current?.getScrollableNode()?.dataset.ownedThread).toBe("b");
  });
  it.each(["proposed-plan", "mcp-app", "html-render"] as const)(
    "uses ordinary unmount/remount for an active %s without replacing it before navigation",
    async (kind) => {
      const view = await mount();
      const initial = view.container.querySelector('[data-owned-thread="a"]')!;
      const base = { id: "lifetime-item", createdAt: "2026-03-17T19:12:28.000Z", runId: null };
      const entry: Props["timelineEntries"][number] =
        kind === "proposed-plan"
          ? {
              ...base,
              kind,
              proposedPlan: {
                id: PlanId.make("lifetime-plan"),
                runId: null,
                planMarkdown: "# Preserve owner",
                status: "active",
                createdAt: base.createdAt,
                updatedAt: base.createdAt,
              },
            }
          : kind === "mcp-app"
            ? {
                ...base,
                kind,
                sourceThreadId: ThreadId.make("a"),
                itemId: TurnItemId.make("lifetime-item"),
                revision: "1",
                mcpApp: {
                  attachmentId: "lifetime-app",
                  server: "local",
                  tool: "example",
                  resourceUri: "ui://example",
                },
              }
            : {
                ...base,
                kind,
                htmlRender: { attachmentId: "lifetime-html", title: "Example", height: 320 },
              };
      await view.show("a", [entry]);
      expect(view.container.querySelector('[data-owned-thread="a"]')).toBe(initial);
      await view.show("b");
      expect(initial.isConnected).toBe(false);
      await view.show("a", [entry]);
      expect(view.container.querySelector('[data-owned-thread="a"]')).not.toBe(initial);
    },
  );

  it("preserves an active asynchronous action's failure", async () => {
    const view = await mount();
    const failure = new Error("Authoritative fork permission denied");
    view.onForkFromRun.mockRejectedValueOnce(failure);
    let complete!: () => void;
    lifecycle.wait = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await userEvent.click(view.container.querySelector("button")!);
    const rejected = expect(lifecycle.pending[0]).rejects.toBe(failure);
    await act(async () => {
      complete();
      await rejected;
    });
    expect(view.onForkFromRun).toHaveBeenCalledOnce();
  });
});
