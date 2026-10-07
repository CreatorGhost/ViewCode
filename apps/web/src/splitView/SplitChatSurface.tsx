import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRightIcon, XIcon } from "lucide-react";
import { memo, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";

import ChatView from "../components/ChatView";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { cn } from "../lib/utils";
import {
  useThreadDetail,
  useThreadShell,
  useThreadStalled,
  useThreadStatus,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SplitPaneContext } from "./SplitPaneContext";
import {
  clampSplitRatio,
  remainingAfterClose,
  SPLIT_DEFAULT_RATIO,
  type SplitPair,
} from "./splitView.logic";
import { useSplitViewStore } from "./splitViewStore";

interface SplitPaneProps {
  threadRef: ScopedThreadRef;
  index: 0 | 1;
  focused: boolean;
  onFocus: (threadRef: ScopedThreadRef) => void;
  onClose: (index: 0 | 1) => void;
  onSwap: () => void;
}

/**
 * One full chat for one thread. Memoised on stable props so the other pane's
 * streaming output, the divider drag and focus changes never re-render it;
 * each ChatView subscribes only to its own thread.
 */
const SplitPane = memo(function SplitPane(props: SplitPaneProps) {
  const { threadRef, index, focused, onFocus, onClose, onSwap } = props;
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const stalled = useThreadStalled(threadRef);
  const syncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
    stalled,
  });
  const context = useMemo(() => ({ focused }), [focused]);
  return (
    <SplitPaneContext value={context}>
      <section
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-split-pane={index}
        data-split-pane-focused={focused ? "true" : "false"}
        onPointerDownCapture={focused ? undefined : () => onFocus(threadRef)}
        onFocusCapture={focused ? undefined : () => onFocus(threadRef)}
      >
        <div
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 border-b border-border/60 ps-3 pe-1.5 text-xs",
            focused ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{shell?.title ?? "Thread"}</span>
          <Button
            aria-label="Swap panes"
            size="icon-xs"
            variant="ghost"
            onClick={onSwap}
            title="Swap panes"
          >
            <ArrowLeftRightIcon />
          </Button>
          <Button
            aria-label="Close pane"
            size="icon-xs"
            variant="ghost"
            onClick={() => onClose(index)}
            title="Close pane"
          >
            <XIcon />
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shell !== null || detail !== null ? (
            <ChatView
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              routeKind="server"
              threadSyncPhase={syncPhase}
              reserveTitleBarControlInset={index === 1}
            />
          ) : null}
        </div>
        {focused ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-50 rounded-[inherit] ring-1 ring-inset ring-primary/30"
          />
        ) : null}
      </section>
    </SplitPaneContext>
  );
});

/**
 * Two chats side by side. The route thread is the focused pane; clicking the
 * other pane navigates to its thread, so everything route-driven (sidebar
 * highlight, header, shortcuts) follows focus with no second source of truth.
 */
export function SplitChatSurface(props: { pair: SplitPair; focusedIndex: 0 | 1 }) {
  const { pair, focusedIndex } = props;
  const navigate = useNavigate();
  const ratio = useSplitViewStore((state) => state.ratio);
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);

  const focusThread = useCallback(
    (threadRef: ScopedThreadRef) =>
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) }),
    [navigate],
  );
  const closePane = useCallback(
    (index: 0 | 1) => {
      const store = useSplitViewStore.getState();
      const current = store.pair;
      if (!current) return;
      const remaining = remainingAfterClose(current, index);
      store.close();
      focusThread(remaining);
    },
    [focusThread],
  );
  const swap = useCallback(() => useSplitViewStore.getState().swap(), []);

  // Dragging writes the width straight to the DOM and commits once on release,
  // so neither pane re-renders while the divider moves.
  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const left = leftRef.current;
    if (!container || !left) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rect = container.getBoundingClientRect();
    let next = ratio;
    const move = (moveEvent: PointerEvent) => {
      next = clampSplitRatio((moveEvent.clientX - rect.left) / rect.width, rect.width);
      left.style.flexBasis = `${next * 100}%`;
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      useSplitViewStore.getState().setRatio(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1" data-split-view>
        <div
          ref={leftRef}
          className="flex min-h-0 min-w-0 shrink-0 grow-0"
          style={{ flexBasis: `${ratio * 100}%` }}
        >
          <SplitPane
            key={scopedThreadKey(pair[0])}
            threadRef={pair[0]}
            index={0}
            focused={focusedIndex === 0}
            onFocus={focusThread}
            onClose={closePane}
            onSwap={swap}
          />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border"
          onPointerDown={onDividerPointerDown}
          onDoubleClick={() => useSplitViewStore.getState().setRatio(SPLIT_DEFAULT_RATIO)}
        >
          <span className="absolute inset-y-0 -inset-x-1.5 transition-colors group-hover:bg-primary/15" />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">
          <SplitPane
            key={scopedThreadKey(pair[1])}
            threadRef={pair[1]}
            index={1}
            focused={focusedIndex === 1}
            onFocus={focusThread}
            onClose={closePane}
            onSwap={swap}
          />
        </div>
      </div>
    </SidebarInset>
  );
}
