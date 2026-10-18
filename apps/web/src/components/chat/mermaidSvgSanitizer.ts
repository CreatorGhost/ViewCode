import DOMPurify from "dompurify";

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purifier: ReturnType<typeof DOMPurify> | null = null;

// Mermaid renders $$...$$ labels with KaTeX's MathML output. These are KaTeX's
// MathML element types, without annotation (Mermaid strips it), semantics (only
// a wrapper, so its content is kept), and mglyph (a trusted-input image).
const KATEX_MATHML_TAGS = new Set([
  "math",
  "menclose",
  "mfrac",
  "mi",
  "mlabeledtr",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
]);
// Presentation attributes KaTeX sets on those elements. The existing profiles
// already cover class, style, width, height, display, and xmlns.
const KATEX_MATHML_ATTRIBUTES = new Set([
  "accent",
  "accentunder",
  "columnalign",
  "columnlines",
  "columnspacing",
  "depth",
  "displaystyle",
  "fence",
  "largeop",
  "linebreak",
  "linethickness",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "notation",
  "rowlines",
  "rowspacing",
  "rspace",
  "scriptlevel",
  "separator",
  "stretchy",
  "voffset",
]);

// Diagrams can come from untrusted PR descriptions, so strip anything that can
// navigate, run script, or fetch remote content on top of Mermaid's own strict
// sanitization.
export function sanitizeMermaidSvg(svg: string): string {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeElement", (node, data) => {
      if (data.tagName === "style" && node.textContent) {
        node.textContent = node.textContent.replace(REMOTE_CSS_URL, "none");
      }
    });
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style")
        data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
    });
  }
  const sanitized = purifier.sanitize(svg, {
    // DOMPurify still only accepts <math> under an HTML parent, here the label
    // <div> inside <foreignObject>, and checks every MathML child's namespace.
    ADD_TAGS: ["foreignObject", ...KATEX_MATHML_TAGS],
    ADD_ATTR: (attribute, tagName) =>
      KATEX_MATHML_TAGS.has(tagName) && KATEX_MATHML_ATTRIBUTES.has(attribute),
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "img", "image", "script"],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  });
  // The expanded image parses this as XML, which has no &nbsp; entity. KaTeX
  // writes spaces in math as U+00A0, which HTML serialization turns into &nbsp;.
  return sanitized.replaceAll("&nbsp;", "&#160;");
}
