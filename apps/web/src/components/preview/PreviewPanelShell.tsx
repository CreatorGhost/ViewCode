import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import {
  getPreviewPanelMaxWidth,
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";

export { getPreviewPanelMaxWidth };
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  open?: boolean;
  /**
   * Callers embedding this shell for a different surface (e.g. the pull
   * requests page) should pass their own key so resizing one panel doesn't
   * clobber the other's remembered width.
   */
  widthStorageKey?: string;
  defaultWidth?: number;
  children: ReactNode;
}

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) {
    return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  }

  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const inlineSize = usePreviewPanelInlineSize(hostRef, {
    enabled: props.mode === "inline" && !props.maximized,
    widthStorageKey: props.widthStorageKey,
    defaultWidth: props.defaultWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} hostRef={hostRef} />;
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & {
    inlineSize: PreviewPanelInlineSize;
    hostRef?: RefObject<HTMLDivElement | null>;
  },
) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const localHostRef = useRef<HTMLDivElement | null>(null);
  const hostRef = props.hostRef ?? localHostRef;
  const returnedFocus = useRef(false);
  const { width, handlers } = props.inlineSize;
  // The host's width tweens with the content's slide (index.css, keyed on data-panel-motion so a
  // drag resize stays immediate), on one curve, so the chat edge and the panel move as one piece.
  // A one-step width change with only the content sliding read as a snap at the start of open
  // and the end of close (frame capture, user feedback). The content keeps its full width
  // throughout, so nothing inside the panel re-wraps per frame.
  const contentRef = useRef<HTMLDivElement | null>(null);
  // The shell mounts as the panel opens, so an open mount enters too; while panel motion is
  // suppressed (first paint, navigation) no animation runs and the effect settles it at once.
  // Opening holds the host at zero width for two frames ("pending") so the content's mount,
  // which can stall the main thread for 100ms+, happens while nothing moves; the open animation
  // then starts from a painted panel instead of losing its first frames to the stall.
  const [motion, setMotion] = useState<{
    open: boolean;
    phase: "idle" | "pending" | "enter" | "exit";
  }>(() => ({
    open,
    phase: collapsible && open ? "pending" : "idle",
  }));
  if (collapsible && motion.open !== open) {
    setMotion({ open, phase: open ? "pending" : "exit" });
  }
  useLayoutEffect(() => {
    if (motion.phase !== "pending") return;
    const host = hostRef.current;
    const enter = () =>
      setMotion((current) =>
        current.phase === "pending" ? { ...current, phase: "enter" } : current,
      );
    if (!host?.closest('[data-panel-animations="true"]')) {
      enter();
      return;
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(enter);
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [motion.phase, hostRef]);
  useLayoutEffect(() => {
    if (motion.phase === "idle" || motion.phase === "pending") return;
    const content = contentRef.current;
    const finish = () => setMotion((current) => ({ ...current, phase: "idle" }));
    // No running animation means motion is off (setting, reduced motion): settle at once.
    if (!content || (content.getAnimations?.() ?? []).length === 0) {
      finish();
      return;
    }
    content.addEventListener("animationend", finish, { once: true });
    content.addEventListener("animationcancel", finish, { once: true });
    return () => {
      content.removeEventListener("animationend", finish);
      content.removeEventListener("animationcancel", finish);
    };
  }, [motion.phase]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !collapsible) return;
    return () => {
      if (!host.contains(host.ownerDocument.activeElement) && !returnedFocus.current) return;
      // The toggle moves when the shell unmounts, after an animation or immediately.
      // Restore focus at its committed location if removal cleared focus to body.
      queueMicrotask(() => {
        if (host.ownerDocument.activeElement === host.ownerDocument.body) {
          host.ownerDocument.querySelector<HTMLButtonElement>("[data-right-panel-toggle]")?.focus();
        }
      });
    };
  }, [collapsible, hostRef]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const collapsed = collapsible && !open;
    if (!collapsed) returnedFocus.current = false;
    // Move focus before making its current owner inert, while the toggle is reachable.
    if (collapsed && host.contains(host.ownerDocument.activeElement)) {
      const toggle = host.ownerDocument.querySelector<HTMLButtonElement>(
        "[data-right-panel-toggle]",
      );
      toggle?.focus();
      returnedFocus.current = toggle !== null && host.ownerDocument.activeElement === toggle;
    }
    host.toggleAttribute("inert", collapsed);
  }, [collapsible, open, hostRef]);
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? maximized
            ? // Maximized, the panel's left edge meets the sidebar's own border
              // (or the window edge), so a second border would double it.
              "flex-1"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible && !open && "pointer-events-none",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: maximized
                ? "100%"
                : collapsible && (!open || motion.phase === "pending")
                  ? "0px"
                  : `var(${RESIZABLE_WIDTH_PROPERTY})`,
            } as CSSProperties)
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          ref={contentRef}
          className="flex h-full min-h-0 min-w-0 flex-col"
          data-panel-motion={
            motion.phase === "idle" || motion.phase === "pending" ? undefined : motion.phase
          }
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
