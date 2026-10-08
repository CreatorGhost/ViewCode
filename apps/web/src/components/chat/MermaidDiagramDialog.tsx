import {
  CopyIcon,
  FileCodeIcon,
  ImageDownIcon,
  ScanIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { downloadBlob, readMediaPng } from "../media/mediaContent";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogPopup } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { standaloneDiagramSvg } from "./diagramExport";
import {
  fitTransform,
  type Size,
  type ViewTransform,
  wheelZoomFactor,
  zoomAround,
} from "./diagramViewport";

const BUTTON_ZOOM_STEP = 1.25;
const PNG_SCALE = 2;

/** The diagram as a standalone SVG file, painted on the theme's canvas colour. */
function diagramFile(svg: string, background: string): Blob {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const element = template.content.querySelector("svg");
  // Images and files need XML; the stored markup is HTML-serialized.
  const file = element
    ? standaloneDiagramSvg(new XMLSerializer().serializeToString(element), background)
    : null;
  if (!file) throw new Error("The diagram has no usable size.");
  return new Blob([file], { type: "image/svg+xml" });
}

async function diagramPng(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    return await readMediaPng(url, PNG_SCALE);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ExportAction = "copy" | "png" | "svg";

const EXPORT_FAILURES: Record<ExportAction, string> = {
  copy: "Could not copy diagram",
  png: "Could not download PNG",
  svg: "Could not download SVG",
};

async function exportDiagram(action: ExportAction, svg: string, background: string) {
  try {
    const file = diagramFile(svg, background);
    if (action === "svg") {
      downloadBlob(file, "diagram.svg");
    } else if (action === "png") {
      downloadBlob(await diagramPng(file), "diagram.png");
    } else {
      // Start the clipboard write in the user gesture; rasterizing finishes later.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": diagramPng(file) })]);
      toastManager.add({ type: "success", title: "Diagram copied" });
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: EXPORT_FAILURES[action],
      description: error instanceof Error ? error.message : "The diagram could not be exported.",
    });
  }
}

const canCopyImage =
  typeof navigator !== "undefined" &&
  Boolean(navigator.clipboard?.write) &&
  typeof ClipboardItem !== "undefined";

// A faint dot grid gives the canvas a sense of scale while panning; it is drawn
// from the theme's text colour so it follows every theme.
const CANVAS_GRID_STYLE = {
  backgroundImage:
    "radial-gradient(circle, color-mix(in srgb, var(--foreground) 12%, transparent) 1px, transparent 1.2px)",
  backgroundSize: "18px 18px",
};

/**
 * The inline copy of the diagram stays mounted under the dialog, so this copy
 * gets its own element ids; otherwise its markers and scoped styles would
 * resolve to the inline one.
 */
function withUniqueIds(svg: string): string {
  const id = /<svg[^>]*\sid="([^"]+)"/.exec(svg)?.[1];
  return id ? svg.replaceAll(id, `${id}-expanded`) : svg;
}

function svgNaturalSize(svg: SVGSVGElement): Size | null {
  const [, , width = 0, height = 0] =
    svg
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (!(width > 0 && height > 0)) return null;
  return { width, height };
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={onClick}
            aria-label={label}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Wheel zooms around the cursor, drag pans, double-click fits. No animation. */
function DiagramCanvas({ svg, background }: { svg: string; background: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const sizeRef = useRef<Size | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const html = useMemo(() => withUniqueIds(svg), [svg]);

  const apply = useCallback((next: ViewTransform) => {
    transformRef.current = next;
    if (contentRef.current) {
      contentRef.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    }
    setScale(next.scale);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const size = sizeRef.current;
    if (!viewport || !size) return;
    apply(fitTransform(size, { width: viewport.clientWidth, height: viewport.clientHeight }));
  }, [apply]);

  const zoomBy = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      apply(
        zoomAround(transformRef.current, factor, {
          x: viewport.clientWidth / 2,
          y: viewport.clientHeight / 2,
        }),
      );
    },
    [apply],
  );

  // Inline diagrams shrink to the column; here the SVG keeps its natural size
  // and the transform does the scaling.
  useLayoutEffect(() => {
    const element = contentRef.current?.querySelector("svg");
    if (!element) return;
    const size = svgNaturalSize(element);
    sizeRef.current = size;
    if (size) {
      element.setAttribute("width", String(size.width));
      element.setAttribute("height", String(size.height));
    }
    element.style.maxWidth = "none";
    fit();
  }, [fit]);

  // React's wheel listener is passive, so it cannot stop the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      apply(
        zoomAround(
          transformRef.current,
          wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey),
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        ),
      );
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [apply]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = transformRef.current;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX - x, y: event.clientY - y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    apply({
      ...transformRef.current,
      x: event.clientX - drag.x,
      y: event.clientY - drag.y,
    });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 py-1.5 pr-1.5 pl-3 select-none">
        <span className="font-mono text-2xs text-muted-foreground">Diagram</span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Diagram view">
          {canCopyImage ? (
            <IconAction
              label="Copy image"
              onClick={() => void exportDiagram("copy", svg, background)}
            >
              <CopyIcon className="size-3.5" />
            </IconAction>
          ) : null}
          <IconAction
            label="Download PNG"
            onClick={() => void exportDiagram("png", svg, background)}
          >
            <ImageDownIcon className="size-3.5" />
          </IconAction>
          <IconAction
            label="Download SVG"
            onClick={() => void exportDiagram("svg", svg, background)}
          >
            <FileCodeIcon className="size-3.5" />
          </IconAction>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <IconAction label="Zoom out" onClick={() => zoomBy(1 / BUTTON_ZOOM_STEP)}>
            <ZoomOutIcon className="size-3.5" />
          </IconAction>
          <span className="w-10 text-center font-mono text-2xs text-muted-foreground tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <IconAction label="Zoom in" onClick={() => zoomBy(BUTTON_ZOOM_STEP)}>
            <ZoomInIcon className="size-3.5" />
          </IconAction>
          <IconAction label="Fit to view" onClick={fit}>
            <ScanIcon className="size-3.5" />
          </IconAction>
          <DialogClose
            render={<Button type="button" variant="ghost-muted" size="icon-xs" />}
            aria-label="Close"
          >
            <XIcon className="size-3.5" />
          </DialogClose>
        </span>
      </div>
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-background active:cursor-grabbing"
        style={CANVAS_GRID_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={fit}
      >
        <div
          ref={contentRef}
          className="absolute top-0 left-0 origin-top-left"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </>
  );
}

/** A larger, pannable view of a rendered diagram. */
export function MermaidDiagramDialog({
  svg,
  background,
  open,
  onOpenChange,
}: {
  svg: string;
  /** The theme canvas colour the diagram was drawn for; exports paint it behind the diagram. */
  background: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        aria-label="Diagram"
        showCloseButton={false}
        bottomStickOnMobile={false}
        // Fills the dialog viewport inside its 1rem padding.
        className="h-[calc(100dvh-2rem)] max-w-none overflow-hidden"
      >
        {/* Keyed so a recoloured diagram measures and fits again. */}
        <DiagramCanvas key={svg} svg={svg} background={background} />
      </DialogPopup>
    </Dialog>
  );
}
