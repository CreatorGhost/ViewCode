const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Makes rendered diagram markup stand alone as a file or image: a pixel size
 * from its viewBox (in the app CSS sizes it), the SVG namespace, and the
 * canvas colour painted behind it (in the app the chat frame paints it).
 * Expects XML-serialized markup. Returns null without a usable viewBox.
 */
export function standaloneDiagramSvg(svg: string, background: string): string | null {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open || open[0].endsWith("/>")) return null;
  const tag = open[0];
  const viewBox = /\sviewBox="([^"]*)"/i
    .exec(tag)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite)) return null;
  const [x = 0, y = 0, width = 0, height = 0] = viewBox;
  if (!(width > 0 && height > 0)) return null;

  // Mermaid sizes the element with width="100%" and a max-width style.
  const attributes = tag.slice(4, -1).replace(/\s(?:width|height|style)="[^"]*"/gi, "");
  const namespace = /\sxmlns="/.test(attributes) ? "" : ` xmlns="${SVG_NAMESPACE}"`;
  // Inline, so the diagram's own `rect` rules cannot repaint it.
  const backdrop = `<rect x="${x}" y="${y}" width="${width}" height="${height}" style="fill:${background};stroke:none"/>`;
  return `${svg.slice(0, open.index)}<svg${namespace}${attributes} width="${width}" height="${height}">${backdrop}${svg.slice(open.index + tag.length)}`;
}
