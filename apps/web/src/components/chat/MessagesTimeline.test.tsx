import { formatAgentMessage } from "@t3tools/shared/agentMessages";
import { deriveViewCodeAgentWorkLogEntries } from "./viewcodeAgentTimeline";
import {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  RunId,
  type ComposerContextRecord,
} from "@t3tools/contracts";
import { act, createRef, useLayoutEffect, useState, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { shouldUseRestingComposerLayout } from "../composerFooterLayout";
import { useComposerFocusState } from "./useComposerFocusState";

const legendListTestState = vi.hoisted(() => ({
  data: undefined as unknown,
  onScroll: undefined as (() => void) | undefined,
}));

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
      anchorMaxSize?: number;
      anchorOffset?: number;
      onReady?: (info: { anchorIndex: number }) => void;
    };
    contentInsetEndAdjustment?: number;
    className?: string;
    maintainScrollAtEnd?: boolean | MaintainScrollAtEndOptions;
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    onScroll?: () => void;
    ref?: Ref<LegendListRef>;
  }) => {
    useLayoutEffect(() => {
      legendListTestState.data = props.data;
      legendListTestState.onScroll = props.onScroll;
    });
    if (props.anchoredEndSpace) {
      props.anchoredEndSpace.onReady?.({ anchorIndex: props.anchoredEndSpace.anchorIndex });
    }
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
        data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
        data-anchor-on-ready={Boolean(props.anchoredEndSpace?.onReady)}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-footer-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.footerLayout
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-maintain-visible-content-position-restore={
          typeof props.maintainVisibleContentPosition === "object"
            ? Boolean(props.maintainVisibleContentPosition.shouldRestorePosition)
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;
let resolvePreviewAnnotationImage: typeof import("./MessagesTimeline").resolvePreviewAnnotationImage;

const ElementStub = class ElementStub {};

function stubDomGlobals() {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("Element", ElementStub);
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    Element: ElementStub,
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
}

// The first import transforms the whole timeline graph; on a shared CI runner
// running every web suite at once that alone has taken over 30 seconds.
beforeAll(async () => {
  stubDomGlobals();
  ({ MessagesTimeline, resolvePreviewAnnotationImage } = await import("./MessagesTimeline"));
}, 120_000);

// The scroll-settling test clears every global stub; mounted timeline rows
// still touch `window` through the tooltip's focus handling.
beforeEach(stubDomGlobals);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    runs: [],
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    onAnchorSizeChanged: () => {},
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    runningRunId: null,
    turnDiffSummaries: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 14 }, (_, index) =>
    index === 13 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      runId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl ? { previewUrl } : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders previous and next controls with the minimap", () => {
    const first = buildUserTimelineEntry("First turn");
    const secondBase = buildUserTimelineEntry("Second turn");
    const second = {
      ...secondBase,
      id: "entry-2",
      message: {
        ...secondBase.message,
        id: MessageId.make("message-2"),
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[first, second]} />,
    );

    expect(markup).toContain('aria-label="Previous turn"');
    expect(markup).toContain('aria-label="Next turn"');
  });

  it("anchors the first user message using its measured height", () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildSnapShotTimelineEntry("data:image/png;base64,iVBORw0KGgo=");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        onAnchorReady={onAnchorReady}
        contentInsetEndAdjustment={144}
        timelineEntries={[firstEntry]}
      />,
    );

    expect(markup).toContain('data-anchor-index="0"');
    expect(markup).toContain('data-anchor-offset="24"');
    expect(markup).not.toContain("data-anchor-max-size=");
    expect(markup).toContain('data-content-inset-end="144"');
    expect(markup).toContain("[overflow-anchor:none]");
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-visible-content-position="object"');
    expect(markup).toContain('data-maintain-visible-content-position-data="true"');
    expect(markup).toContain('data-maintain-visible-content-position-size="true"');
    expect(markup).toContain('data-maintain-visible-content-position-restore="true"');
    expect(markup).toContain("Terminal");
    expect(markup).toContain("t3code — Tests");
    expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
    expect(markup).toContain("h-28 w-52 max-w-full");
    expect(onAnchorReady).toHaveBeenCalledOnce();
    expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
  });

  it("does not reserve end space for a follow-up user message", () => {
    const onAnchorReady = vi.fn();
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={secondEntry.message.id}
        onAnchorReady={onAnchorReady}
        timelineEntries={[firstEntry, secondEntry]}
      />,
    );

    expect(markup).not.toContain("data-anchor-index=");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(onAnchorReady).not.toHaveBeenCalled();
  });

  it("snaps to the end on first paint and while idle", () => {
    const entries = [buildUserTimelineEntry("Hello")];
    // A freshly mounted list settles first, even mid-turn; gliding starts after
    // (see the thread switch test below).
    const working = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} isWorking timelineEntries={entries} />,
    );
    expect(working).toContain('data-maintain-scroll-at-end-animated="false"');

    const idle = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={entries} />,
    );
    expect(idle).toContain('data-maintain-scroll-at-end-animated="false"');
  });

  it("snaps to the end while a thread switch settles, even mid-turn", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const flushFrame = () =>
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(0));
      });
    // A work entry renders without the DOM globals that message rows need
    // under react-test-renderer.
    const entries = [
      {
        id: "entry-settle-work",
        kind: "work" as const,
        createdAt: MESSAGE_CREATED_AT,
        entry: {
          id: "work-settle",
          createdAt: MESSAGE_CREATED_AT,
          toolCallId: "call-settle",
          label: "Run lint",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command: "pnpm lint",
          toolLifecycleStatus: "completed" as const,
        },
      },
    ];
    const animatedAttr = (renderer: ReactTestRenderer) =>
      renderer.root.findByProps({ "data-testid": "legend-list" }).props[
        "data-maintain-scroll-at-end-animated"
      ];
    let renderer!: ReactTestRenderer;
    try {
      act(() => {
        renderer = create(
          <MessagesTimeline
            {...buildProps()}
            isWorking
            routeThreadKey="env-1:thread-a"
            timelineEntries={entries}
          />,
        );
      });
      expect(animatedAttr(renderer)).toBe(false);
      flushFrame();
      flushFrame();
      expect(animatedAttr(renderer)).toBe(true);

      act(() => {
        renderer.update(
          <MessagesTimeline
            {...buildProps()}
            isWorking
            routeThreadKey="env-1:thread-b"
            timelineEntries={entries}
          />,
        );
      });
      expect(animatedAttr(renderer)).toBe(false);

      // Two frames later the switch has settled and gliding resumes.
      flushFrame();
      flushFrame();
      expect(animatedAttr(renderer)).toBe(true);
    } finally {
      act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps reserved end space when tool work starts while reading history", () => {
    const runId = RunId.make("turn-with-active-tool");
    const firstEntry = buildUserTimelineEntry("Run the command.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestRun={{
          runId,
          status: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningRunId={runId}
        anchorMessageId={firstEntry.message.id}
        liveFollowEnabled={false}
        timelineEntries={[
          firstEntry,
          {
            id: "entry-active-tool",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-active-tool",
              createdAt: MESSAGE_CREATED_AT,
              runId,
              toolCallId: "call-active-tool",
              label: "Run command",
              tone: "tool",
              itemType: "command_execution",
              command: "git status",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-anchor-index="0"');
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("hands end-following back to the list once the send anchor is released", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // While the send anchor holds the end space open, ChatView owns streaming
    // scrolls and LegendList must not re-pin behind it.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={firstEntry.message.id}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');

    // Dropping the anchor is what actually gives end-following back, so
    // returning to the live edge has to release it — re-enabling live follow
    // alone leaves nothing pinned to the stream.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-scroll-at-end="enabled"');

    // Reading history still wins over both.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          liveFollowEnabled={false}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  function stubFollowTimeline(routeThreadKey: string) {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const props = { ...buildProps(), routeThreadKey };
    const timeline = {
      props,
      scrollTop: 1400,
      flushFrame: () =>
        act(() => {
          const callbacks = [...frames.values()];
          frames.clear();
          callbacks.forEach((callback) => callback(0));
        }),
    };
    const viewport = {
      get scrollTop() {
        return timeline.scrollTop;
      },
      getBoundingClientRect: () => ({ top: 0 }),
    };
    props.listRef.current = {
      getScrollableNode: () => viewport,
      getState: () => ({
        data: legendListTestState.data,
        scroll: timeline.scrollTop,
        scrollLength: 600,
        contentLength: 2000,
        indexByKey: () => 0,
        positionAtIndex: () => 0,
        sizeAtIndex: () => 2000,
        elementAtIndex: () => ({ getBoundingClientRect: () => ({ top: -timeline.scrollTop }) }),
      }),
    } as unknown as LegendListRef;
    return timeline;
  }

  it("remembers a manual reading position when the chat closes before the next frame", async () => {
    const { readTimelinePosition } = await import("./timelineScrollAnchoring");
    const timeline = stubFollowTimeline("environment-local:manual-departure");
    const { props } = timeline;
    let navigateManually = () => {};
    function ChatProbe() {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      useLayoutEffect(() => {
        navigateManually = () => setLiveFollowEnabled(false);
      }, []);
      return (
        <MessagesTimeline
          {...props}
          timelineEntries={[buildUserTimelineEntry("First prompt")]}
          liveFollowEnabled={liveFollowEnabled}
          onManualNavigation={navigateManually}
        />
      );
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(<ChatProbe />);
      });
      await timeline.flushFrame();
      expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true);

      // The scroll event lands before the follow opt-out renders.
      timeline.scrollTop = 1300;
      await act(() => {
        navigateManually();
        legendListTestState.onScroll?.();
      });
      await act(() => renderer?.unmount());
      renderer = undefined;

      expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
        atEnd: false,
        scrollOffset: 1300,
      });
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("keeps a following thread's intent while its timeline is held for the next thread", async () => {
    const { readTimelinePosition } = await import("./timelineScrollAnchoring");
    const timeline = stubFollowTimeline("environment-local:held-departure");
    const { props } = timeline;
    // Smooth follow is still catching up with the stream.
    timeline.scrollTop = 1300;
    const render = (held: boolean) => (
      <MessagesTimeline
        {...props}
        timelineEntries={[buildUserTimelineEntry("First prompt")]}
        liveFollowEnabled={!held}
        paintOnly={held}
      />
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(render(false));
      });
      await timeline.flushFrame();
      expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true);

      await act(() => renderer?.update(render(true)));
      await timeline.flushFrame();

      expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true);
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("remembers a first send held near the top as a reading position", async () => {
    const { readTimelinePosition } = await import("./timelineScrollAnchoring");
    const timeline = stubFollowTimeline("environment-local:anchored-first-send");
    const { props } = timeline;
    timeline.scrollTop = 1300;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <MessagesTimeline
            {...props}
            timelineEntries={[buildUserTimelineEntry("First prompt")]}
            anchorMessageId={MessageId.make("message-1")}
            liveFollowEnabled
          />,
        );
      });
      await timeline.flushFrame();

      expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
        atEnd: false,
        scrollOffset: 1300,
      });
    } finally {
      await act(() => renderer?.unmount());
    }
  });

  it("renders attachment chips bound to server ids and hides their file rows", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-attachments",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-attachments"),
              role: "user",
              text: "See ![shot.png](t3-context://v1/image/img-1) and [notes.txt](t3-context://v1/file/file-1).",
              attachments: [
                {
                  type: "image",
                  id: "thread-1-aaa",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 3,
                },
                {
                  type: "file",
                  id: "thread-1-bbb",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
                {
                  type: "file",
                  id: "thread-1-ccc",
                  name: "legacy.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
              ],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: "img-1" as never,
                    kind: "image",
                    label: "shot.png",
                    attachmentId: "thread-1-aaa",
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 3,
                  },
                  {
                    version: 1,
                    contextId: "file-1" as never,
                    kind: "file",
                    label: "notes.txt",
                    attachmentId: "thread-1-bbb",
                    name: "notes.txt",
                    mimeType: "text/plain",
                    sizeBytes: 3,
                  },
                ],
              },
              runId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // Images report their size like every other attachment chip.
    expect(markup).toContain('aria-label="Image attachment, shot.png, 1 KB"');
    // Selection copy re-emits chips as their canonical links.
    expect(markup).toContain('data-markdown-copy="![shot.png](t3-context://v1/image/img-1)"');
    expect(markup).toContain('aria-label="File attachment, notes.txt, 1 KB"');
    expect(markup).toContain(">1 KB</span>");
    expect(markup).not.toContain('aria-label="Download notes.txt"');
    expect(markup).toContain("legacy.txt");
    expect(markup).not.toContain('href="t3-context://');
    // A picture keeps its tile even though it also has a chip: the chip names it, the tile is
    // the only way to see it. A plain file's row is what a chip replaces.
    expect(markup).toContain("grid-cols-2");
  });

  it("resolves an annotation screenshot through its image context record", () => {
    const image = {
      type: "image" as const,
      id: "thread-1-screenshot",
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const annotation = {
      version: 1 as const,
      contextId: "annotation-1" as never,
      kind: "preview-annotation" as const,
      label: "Checkout button",
      annotationId: "producer-id",
      pageUrl: "https://example.test/checkout",
      pageTitle: "Checkout",
      comment: "This changed after clicking",
      targetSummary: "1 selected element",
      styleChanges: [],
      screenshotContextId: "screenshot-1" as never,
    };
    const screenshotRecord = {
      version: 1 as const,
      contextId: "screenshot-1" as never,
      kind: "image" as const,
      label: "capture.png",
      attachmentId: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };

    expect(
      resolvePreviewAnnotationImage({
        record: annotation,
        recordsById: new Map<string, ComposerContextRecord>([
          [annotation.contextId, annotation],
          [screenshotRecord.contextId, screenshotRecord],
        ]),
        userImages: [image],
        previewImages: [],
        annotationRecordIds: [annotation.contextId],
      }),
    ).toBe(image);
  });

  it("returns no annotation screenshot when its binding cannot be resolved", () => {
    expect(
      resolvePreviewAnnotationImage({
        record: {
          version: 1,
          contextId: "annotation-1" as never,
          kind: "preview-annotation",
          label: "Google",
          annotationId: "producer-id",
          pageUrl: "https://google.com",
          pageTitle: "Google",
          comment: "What is this?",
          targetSummary: "8 drawings",
          styleChanges: [],
          screenshotContextId: "missing-image" as never,
        },
        recordsById: new Map(),
        userImages: [],
        previewImages: [],
        annotationRecordIds: ["annotation-1"],
      }),
    ).toBeNull();
  });

  it("renders structured context records as chips without reparsing text", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-structured",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-structured"),
              role: "user",
              text: "Compare [Terminal 1 line 4](t3-context://v1/terminal/ctx-t) with [gone](t3-context://v1/future/ctx-x).",
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: "ctx-t" as never,
                    kind: "terminal",
                    label: "Terminal 1 line 4",
                    terminalId: "default",
                    terminalLabel: "Terminal 1",
                    lineStart: 4,
                    lineEnd: 4,
                    text: "boom",
                  },
                ],
              },
              runId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("Terminal 1 line 4");
    expect(markup).toContain('data-context-unresolved="true"');
    expect(markup).toContain(">gone<");
    expect(markup).not.toContain('href="t3-context://');
  });
});

describe("ViewCode agent messages on the native timeline", () => {
  it("renders a native user message's validated envelope as an incoming agent card", () => {
    const text = formatAgentMessage({
      messageId: "mail-in",
      fromThreadId: "agent-scout",
      fromName: "Scout",
      replyExpected: true,
      inReplyTo: null,
      body: "The second account can read this repository.",
    });
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[buildUserTimelineEntry(text)]} />,
    );
    expect(markup).toContain('data-agent-message-id="mail-in"');
    expect(markup).toContain("Scout");
    expect(markup).toContain("Reply expected");
    expect(markup).toContain("The second account can read this repository.");
    expect(markup).not.toContain("&lt;viewcode-agent-message");
  });
  it("renders a persisted native ViewCode notice as the outgoing message card", () => {
    const entries = deriveViewCodeAgentWorkLogEntries([
      {
        id: EventId.make("notice-mail-out"),
        tone: "info",
        kind: "viewcode.agent-message.sent",
        summary: "Message to Scout",
        turnId: null,
        createdAt: MESSAGE_CREATED_AT,
        payload: {
          messageId: "mail-out",
          toThreadId: "agent-scout",
          toName: "Scout",
          replyExpected: true,
          inReplyTo: null,
          body: "Read the API boundary before implementing.",
          kind: "message",
          delivery: "queued",
        },
      },
    ]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={entries.map((entry) => ({
          id: entry.id,
          kind: "work",
          createdAt: entry.createdAt,
          entry,
        }))}
      />,
    );
    expect(markup).toContain('data-agent-message-id="mail-out"');
    expect(markup).toContain("Scout");
    expect(markup).toContain("queued");
    expect(markup).toContain("Read the API boundary before implementing.");
  });
});
