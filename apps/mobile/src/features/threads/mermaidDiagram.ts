/**
 * Pages for Mermaid diagrams in a reply. One WebView renders the diagram with Mermaid and posts
 * back the SVG; after that the SVG is shown from a static page with no script at all.
 */

// ponytail: Mermaid (3.6 MB) loads from jsDelivr, pinned to the web app's version and checked by
// SRI, instead of being bundled. Offline phones see the code block; bundle it if that matters.
export const MERMAID_SCRIPT = {
  src: "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js",
  integrity: "sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2",
} as const;

export const MERMAID_INLINE_MAX_HEIGHT = 480;

export interface MermaidColors {
  readonly dark: boolean;
  readonly canvas: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
}

export type MermaidMessage =
  | { readonly type: "rendered"; readonly svg: string; readonly height: number }
  | { readonly type: "error" };

/** JSON that is also safe inside an inline <script>. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028");
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function pageStyle(background: string, maxHeight: number | null): string {
  return `html,body{margin:0;padding:0;background:${background};}
#d{display:flex;justify-content:center;}
#d svg{display:block;max-width:100%;height:auto;${maxHeight === null ? "" : `max-height:${maxHeight}px;`}}`;
}

/** Renders `code` once and posts a {@link MermaidMessage} to React Native. */
export function mermaidRenderHtml(code: string, colors: MermaidColors): string {
  const config = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // The diagram may not restyle itself or turn HTML labels back on.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "htmlLabels",
      "theme",
      "themeVariables",
      "themeCSS",
    ],
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: "basis" },
    theme: "base",
    darkMode: colors.dark,
    fontFamily: "-apple-system, Roboto, 'Segoe UI', sans-serif",
    themeVariables: {
      darkMode: colors.dark,
      background: colors.canvas,
      fontSize: "14px",
      primaryColor: colors.surface,
      primaryTextColor: colors.text,
      primaryBorderColor: colors.border,
      secondaryColor: colors.surface,
      tertiaryColor: colors.surface,
      mainBkg: colors.surface,
      nodeBorder: colors.border,
      textColor: colors.text,
      titleColor: colors.text,
      lineColor: colors.muted,
      clusterBkg: colors.canvas,
      clusterBorder: colors.border,
      edgeLabelBackground: colors.canvas,
      noteBkgColor: colors.surface,
      noteTextColor: colors.text,
      noteBorderColor: colors.border,
      actorBkg: colors.surface,
      actorBorder: colors.border,
      actorTextColor: colors.text,
      signalColor: colors.text,
      signalTextColor: colors.text,
    },
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>${pageStyle("transparent", MERMAID_INLINE_MAX_HEIGHT)}</style>
<script src="${MERMAID_SCRIPT.src}" integrity="${MERMAID_SCRIPT.integrity}" crossorigin="anonymous"></script>
</head><body><div id="d"></div><script>
(function(){
  function post(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}
  if(!window.mermaid){post({type:"error"});return;}
  window.mermaid.initialize(${scriptJson(config)});
  window.mermaid.render("m",${scriptJson(code)}).then(function(r){
    var d=document.getElementById("d");d.innerHTML=r.svg;
    var s=d.querySelector("svg");
    if(!s){post({type:"error"});return;}
    post({type:"rendered",svg:d.innerHTML,height:Math.ceil(s.getBoundingClientRect().height)});
  },function(){post({type:"error"});});
})();
</script></body></html>`;
}

/** A rendered diagram with no script; `zoomable` lets the reader pinch it in full screen. */
export function mermaidStaticHtml(
  svg: string,
  options: { readonly background: string; readonly zoomable: boolean },
): string {
  const viewport = options.zoomable
    ? "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=8,user-scalable=yes"
    : "width=device-width,initial-scale=1,maximum-scale=1";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="${escapeAttribute(viewport)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<style>${pageStyle(options.background, options.zoomable ? null : MERMAID_INLINE_MAX_HEIGHT)}${
    options.zoomable
      ? "html,body{height:100%;}#d{box-sizing:border-box;min-height:100%;padding:16px;align-items:center;}"
      : ""
  }</style>
</head><body><div id="d">${svg}</div></body></html>`;
}

export function readMermaidMessage(data: string): MermaidMessage | null {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    if (message.type === "error") return { type: "error" };
    if (
      message.type === "rendered" &&
      "svg" in message &&
      typeof message.svg === "string" &&
      message.svg.startsWith("<svg") &&
      "height" in message &&
      typeof message.height === "number" &&
      message.height > 0
    ) {
      return { type: "rendered", svg: message.svg, height: message.height };
    }
    return null;
  } catch {
    return null;
  }
}
