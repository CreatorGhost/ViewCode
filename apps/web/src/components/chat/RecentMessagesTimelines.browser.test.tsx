import { EnvironmentId, MessageId, PlanId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps, type ContextType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { RecentMessagesTimelines } from "./RecentMessagesTimelines";
import { MessagesTimeline } from "./MessagesTimeline";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { readTimelinePosition } from "./timelineScrollAnchoring";

type Props = ComponentProps<typeof RecentMessagesTimelines>;
const roots: Root[] = [];
let serial = 0;

function conversation(name: string) {
  const routeThreadKey = `environment-local:recent-${name}-${++serial}`;
  const timelineEntries = Array.from({ length: 24 }, (_, index) => ({
    id: `${routeThreadKey}-entry-${index}`,
    kind: "message" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.make(`${routeThreadKey}-message-${index}`),
      role: "assistant" as const,
      text: `Source ${name} ${index}\n\n${"A variable height paragraph. ".repeat(35 + (index % 4) * 10)}`,
      runId: null,
      createdAt: "2026-03-17T19:12:28.000Z",
      updatedAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  }));
  return { routeThreadKey, timelineEntries };
}

function props(current: ReturnType<typeof conversation>, listRef: Props["listRef"]): Props {
  return {
    ...current,
    listRef,
    isWorking: false,
    activeTurnInProgress: false,
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: readTimelinePosition(current.routeThreadKey)?.atEnd !== false,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function fixture(
  initial: ReturnType<typeof conversation>,
  contexts?: {
    find: ContextType<typeof ThreadFindTimelineContext>;
    canvas: ContextType<typeof ChatCanvasContext>;
  },
  retain = true,
) {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  const Timeline = retain ? RecentMessagesTimelines : MessagesTimeline;
  const listRef = createRef<LegendListRef | null>();
  const restoreRef = createRef<(() => void) | null>();
  const element = (current: ReturnType<typeof conversation>, extra: Partial<Props>) => (
    <ChatCanvasContext value={contexts?.canvas ?? null}>
      <ThreadFindTimelineContext value={contexts?.find ?? null}>
        <Timeline {...props(current, listRef)} cancelPositionRestoreRef={restoreRef} {...extra} />
      </ThreadFindTimelineContext>
    </ChatCanvasContext>
  );
  const show = async (current: ReturnType<typeof conversation>, extra: Partial<Props> = {}) => {
    await act(() => root.render(element(current, extra)));
    await vi.waitFor(() => {
      const viewport = listRef.current?.getScrollableNode();
      expect(viewport).toBeInstanceOf(HTMLElement);
      expect((viewport as HTMLElement).getBoundingClientRect().height).toBeGreaterThan(0);
    });
  };
  await show(initial);
  return {
    container,
    listRef,
    restoreRef,
    show,
    async showCommitted(current: ReturnType<typeof conversation>, extra: Partial<Props> = {}) {
      await act(() => root.render(element(current, extra)));
    },
    async unmount() {
      await act(() => root.unmount());
      roots.splice(roots.indexOf(root), 1);
    },
    viewport() {
      const node = listRef.current?.getScrollableNode();
      if (!(node instanceof HTMLElement)) throw new Error("Missing active timeline");
      return node;
    },
  };
}

function intersectsVisibleViewport(row: HTMLElement, viewport: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  const clip = viewport.getBoundingClientRect();
  if (
    Math.min(box.right, clip.right, window.innerWidth) <= Math.max(box.left, clip.left, 0) ||
    Math.min(box.bottom, clip.bottom, window.innerHeight) <= Math.max(box.top, clip.top, 0)
  )
    return false;
  for (let node: HTMLElement | null = row; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    )
      return false;
  }
  return true;
}

async function atEnd(
  view: Awaited<ReturnType<typeof fixture>>,
  current: ReturnType<typeof conversation>,
) {
  await vi.waitFor(() => {
    const viewport = view.viewport();
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      2,
    );
    const last = current.timelineEntries.at(-1)!;
    const row = viewport.querySelector<HTMLElement>(`[data-message-id="${last.message.id}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(last.message.text.split("\n")[0]!);
    expect(row!.getBoundingClientRect().top).toBeLessThan(viewport.getBoundingClientRect().bottom);
  });
}

describe("recent native timelines", () => {
  it("retains the real list and reading row across a warm switch", async () => {
    const a = conversation("reading-a");
    const b = conversation("reading-b");
    const view = await fixture(a);
    await atEnd(view, a);
    const list = view.listRef.current;
    const viewport = view.viewport();
    await view.show(a, { liveFollowEnabled: false });
    await userEvent.wheel(viewport, { delta: { y: -1800 } });
    await vi.waitFor(() => expect(readTimelinePosition(a.routeThreadKey)?.atEnd).toBe(false));
    const position = readTimelinePosition(a.routeThreadKey)!;
    const selector = `[data-timeline-row-id="${position.rowId}"]`;
    const row = viewport.querySelector(selector);
    expect(row).not.toBeNull();
    await view.show(b);
    await atEnd(view, b);
    expect(view.listRef.current).not.toBe(list);
    expect(viewport.getBoundingClientRect().height).toBe(0);
    const inactive = viewport.closest<HTMLElement>("[data-recent-timeline-pane]")!;
    expect(inactive.hidden).toBe(true);
    expect(inactive.inert).toBe(true);
    expect(inactive.getAttribute("aria-hidden")).toBe("true");
    await view.show(a);
    expect(view.viewport()).toBe(viewport);
    await vi.waitFor(() => {
      expect(viewport.querySelector(selector)).toBe(row);
      expect(intersectsVisibleViewport(row as HTMLElement, viewport)).toBe(true);
      const offset = viewport.getBoundingClientRect().top - row!.getBoundingClientRect().top;
      expect(Math.abs(offset - position.offsetWithinRow)).toBeLessThanOrEqual(2);
    });
  });

  it("keeps a loaded retained timeline visible at the second frame of a warm return", async () => {
    const a = conversation("frame-a");
    const b = conversation("frame-b");
    const view = await fixture(a);
    const visible = () => {
      const viewport = view.viewport();
      return Array.from(viewport.querySelectorAll<HTMLElement>("[data-timeline-root]")).some(
        (row) => intersectsVisibleViewport(row, viewport),
      );
    };
    await vi.waitFor(() => expect(visible()).toBe(true));
    await view.show(b);
    await vi.waitFor(() => expect(visible()).toBe(true));
    for (let index = 0; index < 12; index++) {
      await view.showCommitted(index % 2 === 0 ? a : b);
      let frameVisible = false;
      await act(async () => {
        frameVisible = await new Promise<boolean>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(visible()))),
        );
      });
      expect(frameVisible, `warm return ${index}`).toBe(true);
    }
  });

  it("restores the visible end position by the second frame of a retained warm return", async () => {
    const a = conversation("end-return-a");
    const b = conversation("end-return-b");
    const view = await fixture(a);
    await atEnd(view, a);
    const viewport = view.viewport();
    const last = a.timelineEntries.at(-1)!;
    const selector = `[data-message-id="${last.message.id}"]`;
    await vi.waitFor(() => {
      const row = viewport.querySelector<HTMLElement>(selector);
      expect(row).not.toBeNull();
      expect(intersectsVisibleViewport(row!, viewport)).toBe(true);
    });
    const lastRow = viewport.querySelector<HTMLElement>(selector);
    await view.show(b);
    await atEnd(view, b);
    await vi.waitFor(() => {
      const row = view
        .viewport()
        .querySelector<HTMLElement>(`[data-message-id="${b.timelineEntries.at(-1)!.message.id}"]`);
      expect(row).not.toBeNull();
      expect(intersectsVisibleViewport(row!, view.viewport())).toBe(true);
    });
    await view.showCommitted(a);
    const result = await new Promise<{ visible: boolean; distanceToEnd: number }>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const row = view.viewport().querySelector<HTMLElement>(selector);
          resolve({
            visible: row !== null && intersectsVisibleViewport(row, view.viewport()),
            distanceToEnd:
              view.viewport().scrollHeight -
              view.viewport().clientHeight -
              view.viewport().scrollTop,
          });
        }),
      ),
    );
    expect(view.viewport()).toBe(viewport);
    expect(viewport.querySelector(selector)).toBe(lastRow);
    expect(result.visible).toBe(true);
    expect(Math.abs(result.distanceToEnd)).toBeLessThanOrEqual(2);
  });

  it.each([true, false])(
    "restores width-invalidated end and reading positions, retained=%s",
    async (retain) => {
      const a = conversation("resize-a");
      const b = conversation("resize-b");
      const view = await fixture(a, undefined, retain);
      await atEnd(view, a);
      let viewport = view.viewport();
      await view.show(b);
      const activeB = view.viewport();
      await act(() => {
        view.container.style.width = "680px";
      });
      if (retain) {
        await vi.waitFor(() => expect(viewport.isConnected).toBe(false));
        expect(view.viewport()).toBe(activeB);
      }
      await view.show(a);
      viewport = view.viewport();
      await atEnd(view, a);
      await view.show(a, { liveFollowEnabled: false });
      await userEvent.wheel(viewport, { delta: { y: -1800 } });
      await vi.waitFor(() => expect(readTimelinePosition(a.routeThreadKey)?.atEnd).toBe(false));
      const position = readTimelinePosition(a.routeThreadKey)!;
      await view.show(b);
      await act(() => {
        view.container.style.width = "820px";
      });
      if (retain) await vi.waitFor(() => expect(viewport.isConnected).toBe(false));
      await view.show(a);
      viewport = view.viewport();
      await vi.waitFor(() => {
        const row = viewport.querySelector<HTMLElement>(
          `[data-timeline-row-id="${position.rowId}"]`,
        );
        expect(row).not.toBeNull();
        const offset = viewport.getBoundingClientRect().top - row!.getBoundingClientRect().top;
        expect(Math.abs(offset - position.offsetWithinRow)).toBeLessThanOrEqual(2);
      });
    },
  );

  it("follows canonical appended content after a fully loaded list returns", async () => {
    const a = conversation("append-a");
    const b = conversation("append-b");
    const view = await fixture(a);
    await atEnd(view, a);
    await view.show(b);
    await atEnd(view, b);
    const last = a.timelineEntries.at(-1)!;
    const changed = {
      ...a,
      timelineEntries: [
        ...a.timelineEntries,
        {
          ...last,
          id: "canonical-appended-entry",
          message: {
            ...last.message,
            id: MessageId.make("canonical-appended-message"),
            text: "New canonical continuation. ".repeat(200).trim(),
          },
        },
      ],
    };
    await view.show(changed);
    await atEnd(view, changed);
    expect(
      view.viewport().querySelectorAll('[data-message-id="canonical-appended-message"]'),
    ).toHaveLength(1);
  });

  it("reconciles canonical changes on return instead of replaying a hidden snapshot", async () => {
    const a = conversation("canonical-a");
    const b = conversation("canonical-b");
    const view = await fixture(a);
    await atEnd(view, a);
    const last = a.timelineEntries.at(-1)!;
    const row = view.viewport().querySelector(`[data-message-id="${last.message.id}"]`);
    await view.show(b);
    const changed = {
      ...a,
      timelineEntries: [
        ...a.timelineEntries.slice(0, -1),
        {
          ...last,
          message: { ...last.message, text: "Canonical replacement after rollback" },
        },
      ],
    };
    await view.show(changed);
    await vi.waitFor(() =>
      expect(view.viewport().textContent).toContain("Canonical replacement after rollback"),
    );
    expect(view.viewport().querySelector(`[data-message-id="${last.message.id}"]`)).toBe(row);
    expect(view.viewport().textContent).not.toContain("Source canonical-a 23");
  });

  it("evicts the oldest fourth conversation while retaining the two more recent lists", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map(conversation);
    const view = await fixture(a!);
    const aViewport = view.viewport();
    await view.show(b!);
    await view.show(c!);
    const cViewport = view.viewport();
    await view.show(d!);
    expect(view.container.querySelectorAll("[data-recent-timeline-pane]")).toHaveLength(3);
    expect(aViewport.isConnected).toBe(false);
    await view.show(c!);
    expect(view.viewport()).toBe(cViewport);
    await view.show(a!);
    expect(view.viewport()).not.toBe(aViewport);
    await atEnd(view, a!);
  });

  it("publishes only the visible list's canvas, restore and find handles", async () => {
    const a = conversation("find-a");
    const b = conversation("find-b");
    const reader = createRef<NonNullable<Props["findPositionReaderRef"]>["current"]>();
    const registerTimeline = vi.fn();
    const view = await fixture(a, {
      find: {
        findOpen: false,
        findExpanded: false,
        findQuery: "",
        activeFindMatch: null,
        findNavigationId: 0,
        findPositionReaderRef: reader,
      },
      canvas: {
        container: { width: 900, height: 600 },
        lane: { padding: 0, minChatWidth: 0 },
        layout: resolveChatCanvasLayout({ container: { width: 900, height: 600 }, preview: null }),
        previewKey: null,
        reportPreview: () => {},
        clearPreview: () => {},
        registerTimeline,
        reportDetailsCard: () => {},
        detailsCardTopInset: 0,
      },
    });
    await atEnd(view, a);
    const aReader = reader.current;
    expect(aReader).toBeTypeOf("function");
    await view.show(b);
    await atEnd(view, b);
    expect(registerTimeline.mock.calls.at(-1)?.[0]).toBe(view.viewport());
    expect(reader.current).not.toBe(aReader);
    await view.show(a);
    expect(registerTimeline.mock.calls.at(-1)?.[0]).toBe(view.viewport());
    expect(reader.current).toBeTypeOf("function");
    await view.unmount();
    expect(view.listRef.current).toBeNull();
    expect(view.restoreRef.current).toBeNull();
    expect(reader.current).toBeNull();
    expect(registerTimeline.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("keeps an expanded work group when the same retained identity is reactivated", async () => {
    const a = conversation("disclosure-a");
    const b = conversation("disclosure-b");
    const timelineEntries: Props["timelineEntries"] = ["vp lint", "vp test"].map(
      (command, index) => ({
        id: `work-${index}`,
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: `work-${index}`,
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Ran command",
          command,
          tone: "tool",
          itemType: "command_execution",
          toolLifecycleStatus: "completed",
        },
      }),
    );
    const view = await fixture(a);
    await view.show(a, { timelineEntries });
    const summary = Array.from(view.viewport().querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Ran 2 commands"),
    );
    expect(summary).toBeDefined();
    await userEvent.click(summary!);
    await vi.waitFor(() => expect(view.viewport().textContent).toContain("vp lint"));
    await view.show(b);
    await view.show(a, { timelineEntries });
    await vi.waitFor(() => expect(view.viewport().textContent).toContain("vp lint"));
    expect(view.viewport().textContent).toContain("vp test");
  });

  it("hides the previous selection toolbar and quotes only the active thread", async () => {
    const a = conversation("selection-a");
    const b = conversation("selection-b");
    const view = await fixture(a);
    const cite = vi.fn<NonNullable<Props["onCiteAssistantText"]>>(() => true);
    const selectLastResponse = async () => {
      await userEvent.keyboard("{Shift>}{/Shift}");
      const source = Array.from(
        view.viewport().querySelectorAll("[data-assistant-citation-source]"),
      ).at(-1)!;
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      while (walker.nextNode())
        if (walker.currentNode.textContent?.trim()) last = walker.currentNode;
      expect(last).not.toBeNull();
      const range = document.createRange();
      const length = last!.textContent!.length;
      range.setStart(last!, Math.max(0, length - 25));
      range.setEnd(last!, length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    };
    const visibleQuotes = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label="Quote selection in this chat"]'),
      ).filter((button) => button.getBoundingClientRect().height > 0);
    await view.show(a, { onCiteAssistantText: cite });
    await atEnd(view, a);
    await selectLastResponse();
    await vi.waitFor(() => expect(visibleQuotes()).toHaveLength(1));
    await view.show(b, { onCiteAssistantText: cite });
    await atEnd(view, b);
    expect(visibleQuotes()).toHaveLength(0);
    const sentinel = document.body.appendChild(document.createElement("button"));
    sentinel.textContent = "Outside the timeline";
    const expectUninterceptedTab = async () => {
      let prevented: boolean | undefined;
      const observe = (event: KeyboardEvent) => {
        if (event.key === "Tab") prevented = event.defaultPrevented;
      };
      document.addEventListener("keydown", observe);
      sentinel.focus();
      await userEvent.keyboard("{Tab}");
      document.removeEventListener("keydown", observe);
      expect(prevented).toBe(false);
      expect(document.activeElement).not.toBe(sentinel);
    };
    await selectLastResponse();
    await vi.waitFor(() => expect(visibleQuotes()).toHaveLength(1));
    await userEvent.click(visibleQuotes()[0]!);
    expect(cite).toHaveBeenCalledOnce();
    expect(cite.mock.calls[0]?.[0]).toMatchObject({ threadId: b.routeThreadKey.split(":")[1] });
    window.getSelection()?.removeAllRanges();
    await view.show(a, { onCiteAssistantText: cite });
    expect(document.querySelector('[aria-label="Quote selection in this chat"]')).toBeNull();
    await expectUninterceptedTab();
  });

  it("dismisses a body-portaled table menu on switch, return and eviction", async () => {
    const table = conversation("portal-a");
    const a = {
      ...table,
      timelineEntries: [
        {
          ...table.timelineEntries[0]!,
          message: {
            ...table.timelineEntries[0]!.message,
            text: "| Field | Value |\n| --- | --- |\n| Ready | Native timeline |",
          },
        },
      ],
    };
    const b = conversation("portal-b");
    const view = await fixture(a);
    const openMenu = async () => {
      const trigger = view.viewport().querySelector<HTMLElement>('[aria-label="Copy table"]');
      expect(trigger).not.toBeNull();
      await userEvent.click(trigger!);
      await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
      expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("Copy as Markdown");
    };
    await openMenu();
    await view.show(b);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    await view.show(a);
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    await openMenu();
    await view.show(b);
    await view.show(conversation("portal-c"));
    await view.show(conversation("portal-d"));
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    expect(
      view.container.querySelector(`[data-recent-timeline-pane="${a.routeThreadKey}"]`),
    ).toBeNull();
  });

  it("unmounts lifetime-bound plan content only after leaving its active thread", async () => {
    const a = conversation("plan-lifetime-a");
    const b = conversation("plan-lifetime-b");
    const view = await fixture(a);
    const original = view.viewport();
    const plan: Props["timelineEntries"][number] = {
      id: "proposed-plan-lifetime",
      kind: "proposed-plan",
      createdAt: "2026-03-17T19:12:28.000Z",
      proposedPlan: {
        id: PlanId.make("plan-lifetime"),
        runId: null,
        planMarkdown:
          "# Native plan lifetime\n\nKeep the in-flight save and dialog owner alive until navigation.",
        status: "active",
        createdAt: "2026-03-17T19:12:28.000Z",
        updatedAt: "2026-03-17T19:12:28.000Z",
      },
    };
    const timelineEntries = [plan];
    await view.show(a, { timelineEntries });
    expect(view.viewport()).toBe(original);
    await vi.waitFor(() => expect(view.viewport().textContent).toContain("Native plan lifetime"));
    await view.show(b);
    expect(original.isConnected).toBe(false);
    await view.show(a, { timelineEntries });
    expect(view.viewport()).not.toBe(original);
    expect(view.viewport().textContent).toContain("Native plan lifetime");
    const fresh = view.viewport();
    await view.show(a);
    expect(view.viewport()).toBe(fresh);
    await view.show(b);
    expect(fresh.isConnected).toBe(true);
    await view.show(a);
    expect(view.viewport()).toBe(fresh);
  });

  it("keeps independent split-pane list ownership", async () => {
    const a = conversation("split-a");
    const b = conversation("split-b");
    const c = conversation("split-c");
    const left = await fixture(a);
    const right = await fixture(b);
    const rightList = right.listRef.current;
    const rightViewport = right.viewport();
    await left.show(c);
    await left.show(a);
    expect(right.listRef.current).toBe(rightList);
    expect(right.viewport()).toBe(rightViewport);
    expect(rightViewport.getBoundingClientRect().height).toBeGreaterThan(0);
    await atEnd(right, b);
  });
});
