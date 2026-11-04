import { describe, expect, it } from "vite-plus/test";

import { markdownEndsWithClosedFence } from "@t3tools/mobile-markdown-text/markdown";

import { mermaidRenderHtml, mermaidStaticHtml, readMermaidMessage } from "./mermaidDiagram";

const COLORS = {
  dark: true,
  canvas: "#111111",
  surface: "#222222",
  text: "#eeeeee",
  muted: "#999999",
  border: "#333333",
};

describe("markdownEndsWithClosedFence", () => {
  it("waits while the last fence is still open", () => {
    expect(markdownEndsWithClosedFence("Here:\n\n```mermaid\nflowchart LR\n  A --> B")).toBe(false);
    expect(markdownEndsWithClosedFence("Here:\n\n```mermaid")).toBe(false);
    expect(markdownEndsWithClosedFence("```mermaid\nA --> B\n``")).toBe(false);
  });

  it("renders once the fence closes, indented or with trailing space", () => {
    expect(markdownEndsWithClosedFence("```mermaid\nA --> B\n```")).toBe(true);
    expect(markdownEndsWithClosedFence("1. Step\n   ```mermaid\n   A --> B\n   ```  \n")).toBe(
      true,
    );
    expect(markdownEndsWithClosedFence("~~~mermaid\nA --> B\n~~~")).toBe(true);
  });
});

describe("mermaid pages", () => {
  it("keeps diagram source from closing the render script", () => {
    const html = mermaidRenderHtml('A["</script><script>alert(1)</script>"] --> B', COLORS);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("\\u003c/script>");
  });

  it("shows a rendered diagram without allowing scripts", () => {
    const html = mermaidStaticHtml("<svg></svg>", { background: "#111", zoomable: true });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("user-scalable=yes");
    expect(html).not.toContain("<script");
  });

  it("accepts only a rendered SVG or an error from the page", () => {
    expect(readMermaidMessage('{"type":"rendered","svg":"<svg/>","height":120}')).toEqual({
      type: "rendered",
      svg: "<svg/>",
      height: 120,
    });
    expect(readMermaidMessage('{"type":"error"}')).toEqual({ type: "error" });
    expect(readMermaidMessage('{"type":"rendered","svg":"<img onerror=x>","height":1}')).toBeNull();
    expect(readMermaidMessage('{"type":"rendered","svg":"<svg/>","height":0}')).toBeNull();
    expect(readMermaidMessage("not json")).toBeNull();
  });
});
