import type { DOMPurify } from "dompurify";
import { TriangleAlertIcon } from "lucide-react";
import type { Mermaid } from "mermaid";
import {
  type ReactNode,
  use,
  useDeferredValue,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MermaidDiagramDialog } from "./MermaidDiagramDialog";
import {
  buildMermaidTheme,
  deriveDiagramPalette,
  type DiagramPalette,
  type DiagramTokens,
  diagramPaletteSignature,
  flattenColor,
  mermaidRenderKey,
  parseCssColor,
  planFlowchartTones,
  type Rgb,
  type Rgba,
} from "./mermaidTheme";

interface DiagramTheme {
  readonly palette: DiagramPalette;
  readonly signature: string;
}

// ---------------------------------------------------------------------------
// Theme: read the live tokens so diagrams follow every theme and appearance.
// ---------------------------------------------------------------------------

const TOKEN_EXPRESSIONS: Record<keyof DiagramTokens, string> = {
  canvas: "var(--background)",
  text: "var(--foreground)",
  muted: "var(--muted-foreground)",
  border: "var(--border)",
  accent: "var(--app-theme-accent, var(--primary))",
  warning: "var(--warning)",
  danger: "var(--destructive)",
};

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

let colorCanvas: CanvasRenderingContext2D | null | undefined;

// Computed colors come back in whatever space the token was written in (the
// palettes use oklch); a 1px canvas converts any of them to sRGB.
function resolveViaCanvas(color: string): Rgba | null {
  if (colorCanvas === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorCanvas = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorCanvas) return null;
  colorCanvas.clearRect(0, 0, 1, 1);
  colorCanvas.fillStyle = color;
  colorCanvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = colorCanvas.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

function readDiagramTheme(): DiagramTheme {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.append(probe);
  try {
    const read = (expression: string): Rgba | null => {
      probe.style.color = expression;
      const computed = getComputedStyle(probe).color;
      return parseCssColor(computed) ?? resolveViaCanvas(computed);
    };
    const dark = document.documentElement.classList.contains("dark");
    const canvasColor = read(TOKEN_EXPRESSIONS.canvas);
    const canvas = canvasColor ? flattenColor(canvasColor, dark ? BLACK : WHITE) : WHITE;
    const token = (name: keyof DiagramTokens, fallback: Rgb): Rgb => {
      const color = read(TOKEN_EXPRESSIONS[name]);
      return color ? flattenColor(color, canvas) : fallback;
    };
    const text = token("text", dark ? WHITE : BLACK);
    const palette = deriveDiagramPalette(
      {
        canvas,
        text,
        muted: token("muted", text),
        border: token("border", text),
        accent: token("accent", text),
        warning: token("warning", text),
        danger: token("danger", text),
      },
      getComputedStyle(document.body).fontFamily,
    );
    return { palette, signature: diagramPaletteSignature(palette) };
  } finally {
    probe.remove();
  }
}

let currentTheme: DiagramTheme | null = null;
let themeObserver: MutationObserver | null = null;
const themeListeners = new Set<() => void>();

function refreshDiagramTheme() {
  const next = readDiagramTheme();
  if (next.signature === currentTheme?.signature) return;
  currentTheme = next;
  for (const listener of themeListeners) listener();
}

// The theme is applied as attributes and inline variables on <html>, so one
// observer covers theme, appearance and custom palette edits. It only runs
// while a diagram is mounted.
function subscribeDiagramTheme(listener: () => void) {
  themeListeners.add(listener);
  if (!themeObserver) {
    themeObserver = new MutationObserver(refreshDiagramTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size > 0) return;
    themeObserver?.disconnect();
    themeObserver = null;
    currentTheme = null;
  };
}

function getDiagramTheme(): DiagramTheme {
  currentTheme ??= readDiagramTheme();
  return currentTheme;
}

// ---------------------------------------------------------------------------
// Rendering: one diagram at a time, cached by theme and source.
// ---------------------------------------------------------------------------

type MermaidRenderResult =
  | { readonly status: "rendered"; readonly svg: string }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

interface MermaidModules {
  readonly mermaid: Mermaid;
  readonly purifier: DOMPurify;
}

let modulesPromise: Promise<MermaidModules> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;
const MAX_CACHED_RENDERS = 64;
// Pending renders are never evicted, because use() must get the same promise on retry.
const renderCache = new Map<string, Promise<MermaidRenderResult>>();
const settledRenders = new WeakSet<Promise<MermaidRenderResult>>();

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;

// Diagrams can come from untrusted PR descriptions, so strip anything that can
// navigate, run script, or fetch remote content on top of Mermaid's own strict
// sanitization. CSS keeps only local url(#id) references; label text is untouched.
function createPurifier(createDOMPurify: DOMPurify): DOMPurify {
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) {
      node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
    }
  });
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style") data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
  });
  return purifier;
}

// Mermaid and its sanitizer are ~1MB, so they only load once a diagram is shown.
function loadModules(): Promise<MermaidModules> {
  modulesPromise ??= Promise.all([import("mermaid"), import("dompurify")])
    .then(([mermaid, dompurify]) => ({
      mermaid: mermaid.default,
      purifier: createPurifier(dompurify.default),
    }))
    .catch((error: unknown) => {
      modulesPromise = null;
      throw error;
    });
  return modulesPromise;
}

function configureMermaid(mermaid: Mermaid, palette: DiagramPalette) {
  const { themeVariables, themeCSS } = buildMermaidTheme(palette);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // HTML labels and theme CSS are mounted while Mermaid lays the diagram
    // out, before sanitizing, so diagram directives must not set them. The
    // theme is ours too; a diagram may still opt into `look: handDrawn`.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "htmlLabels",
      "themeCSS",
      "theme",
      "themeVariables",
      "fontFamily",
      "darkMode",
    ],
    htmlLabels: false,
    theme: "base",
    look: "classic",
    handDrawnSeed: 1,
    darkMode: palette.dark,
    fontFamily: palette.fontFamily,
    themeVariables,
    themeCSS,
    flowchart: {
      htmlLabels: false,
      curve: "basis",
      padding: 16,
      nodeSpacing: 44,
      rankSpacing: 52,
      diagramPadding: 16,
      wrappingWidth: 220,
    },
    sequence: { mirrorActors: false, actorMargin: 56, boxMargin: 12, noteMargin: 12 },
  });
}

interface FlowDbLike {
  getSubGraphs(): ReadonlyArray<{
    id: string;
    nodes: ReadonlyArray<string>;
    classes: ReadonlyArray<string>;
  }>;
  getVertices(): unknown;
}

interface FlowVertexLike {
  id: string;
  type?: string;
  styles: ReadonlyArray<string>;
  classes: ReadonlyArray<string>;
}

/**
 * Flowchart groups get their palette colours as Mermaid `class` statements,
 * so Mermaid itself puts the classes on the right nodes and clusters. Any
 * failure here just means a single-tone diagram.
 */
async function flowchartToneStatements(
  mermaid: Mermaid,
  source: string,
  palette: DiagramPalette,
): Promise<string[]> {
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    if (!diagram.type.startsWith("flowchart")) return [];
    const db = diagram.db as unknown as Partial<FlowDbLike>;
    if (typeof db.getSubGraphs !== "function" || typeof db.getVertices !== "function") return [];
    const vertices = db.getVertices();
    if (!(vertices instanceof Map)) return [];
    return planFlowchartTones(
      {
        subgraphs: db.getSubGraphs().map((subgraph) => ({
          id: subgraph.id,
          nodes: subgraph.nodes,
          styled: subgraph.classes.length > 0,
        })),
        vertices: [...(vertices as Map<string, FlowVertexLike>).values()].map((vertex) => ({
          id: vertex.id,
          shape: vertex.type,
          styled: vertex.styles.length > 0 || vertex.classes.length > 0,
        })),
      },
      palette.cycle,
    );
  } catch {
    return [];
  }
}

async function renderOnce(mermaid: Mermaid, text: string): Promise<string> {
  const id = `mermaid-diagram-${nextDiagramId++}`;
  try {
    return (await mermaid.render(id, text)).svg;
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

const LABEL_PILL_X = 6;
const LABEL_PILL_Y = 3;

/** Sanitizes, then gives edge labels a padded, rounded background. */
function finishSvg(purifier: DOMPurify, svg: string): string {
  const sanitized = purifier.sanitize(svg, {
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "img", "image", "script"],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  });
  // Template content is inert: nothing in it loads or runs while it is edited.
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  for (const rect of template.content.querySelectorAll(".edgeLabel rect.background")) {
    // Mermaid draws a background behind every edge, labelled or not.
    if (!rect.parentElement?.textContent?.trim()) {
      rect.remove();
      continue;
    }
    const [x, y, width, height] = ["x", "y", "width", "height"].map((name) =>
      Number(rect.getAttribute(name)),
    );
    if (x === undefined || y === undefined || width === undefined || height === undefined) continue;
    if (![x, y, width, height].every(Number.isFinite)) continue;
    const paddedHeight = height + LABEL_PILL_Y * 2;
    rect.setAttribute("x", String(x - LABEL_PILL_X));
    rect.setAttribute("y", String(y - LABEL_PILL_Y));
    rect.setAttribute("width", String(width + LABEL_PILL_X * 2));
    rect.setAttribute("height", String(paddedHeight));
    rect.setAttribute("rx", String(Math.min(6, paddedHeight / 2)));
  }
  return template.innerHTML;
}

// Mermaid also lazy-loads diagram chunks inside render(); losing the network
// there is worth a retry, unlike a syntax error.
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

async function renderMermaid(source: string, theme: DiagramTheme): Promise<MermaidRenderResult> {
  let modules: MermaidModules;
  try {
    modules = await loadModules();
  } catch {
    return { status: "error", message: "Mermaid failed to load.", retryable: true };
  }
  const { mermaid, purifier } = modules;
  try {
    // initialize() mutates global config, so renders run one at a time.
    configureMermaid(mermaid, theme.palette);
    const tones = await flowchartToneStatements(mermaid, source, theme.palette);
    let svg: string;
    try {
      svg = await renderOnce(mermaid, tones.length > 0 ? `${source}\n${tones.join("\n")}` : source);
    } catch (error) {
      if (tones.length === 0) throw error;
      svg = await renderOnce(mermaid, source);
    }
    return { status: "rendered", svg: finishSvg(purifier, svg) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The diagram could not be rendered.";
    return { status: "error", message, retryable: CHUNK_LOAD_ERROR.test(message) };
  }
}

function evictSettledRenders() {
  for (const [key, result] of renderCache) {
    if (renderCache.size <= MAX_CACHED_RENDERS) return;
    if (settledRenders.has(result)) renderCache.delete(key);
  }
}

function mermaidRenderPromise(source: string, theme: DiagramTheme) {
  const key = mermaidRenderKey(source, theme.signature);
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }
  const result = renderQueue.then(() => renderMermaid(source, theme));
  renderQueue = result;
  void result.then(() => {
    settledRenders.add(result);
    evictSettledRenders();
  });
  renderCache.set(key, result);
  evictSettledRenders();
  return result;
}

/**
 * Suspends until the diagram renders in the current theme. A diagram Mermaid
 * cannot parse shows `fallback` (the highlighted source) with a short note.
 */
export function MermaidDiagram({
  source,
  fallback,
  expanded,
  onExpandedChange,
  onFailedChange,
}: {
  source: string;
  fallback: ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Lets the header hide diagram-only actions while the source shows instead. */
  onFailedChange: (failed: boolean) => void;
}) {
  const [, setAttempt] = useState(0);
  // Deferred, so a theme switch keeps showing the old diagram until the
  // recoloured one is ready instead of flashing the loading state.
  const theme = useDeferredValue(
    useSyncExternalStore(subscribeDiagramTheme, getDiagramTheme, getDiagramTheme),
  );
  const trimmed = source.trim();
  const result = use(mermaidRenderPromise(trimmed, theme));
  const failed = result.status === "error";
  useEffect(() => onFailedChange(failed), [failed, onFailedChange]);

  if (result.status === "error") {
    return (
      <>
        {fallback}
        <div className="flex items-center gap-1.5 border-t border-border/60 py-1 pr-1.5 pl-3 text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              Couldn't render diagram
            </TooltipTrigger>
            <TooltipPopup side="top">{result.message}</TooltipPopup>
          </Tooltip>
          {result.retryable ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                renderCache.delete(mermaidRenderKey(trimmed, theme.signature));
                setAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <div className="p-1.5 pt-1">
      <button
        type="button"
        aria-label="Expand diagram"
        className="flex w-full cursor-zoom-in justify-center rounded-md bg-background px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-auto [&_svg]:max-w-full"
        onClick={() => onExpandedChange(true)}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
      <MermaidDiagramDialog svg={result.svg} open={expanded} onOpenChange={onExpandedChange} />
    </div>
  );
}
