import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import { remarkCopySections } from "./markdown-copy-sections";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCopySections]}>{markdown}</ReactMarkdown>,
  );
}

const sections = (html: string) => html.split('data-copy-section=""').length - 1;

describe("remarkCopySections", () => {
  it("wraps a drafted message between two rules, keeping the rules", () => {
    const html = renderMarkdown(
      "Here's the message:\n\n---\n\nHi Lorenz,\n\n1. First\n2. Second\n\n---\n\nI left out dates.",
    );

    expect(sections(html)).toBe(1);
    expect(html).toMatch(
      /<hr\/>\s*<div data-copy-section="">.*Hi Lorenz.*Second.*<\/div>\s*<hr\/>/s,
    );
    expect(html).not.toMatch(/data-copy-section="">[^]*Here&#x27;s the message/);
    expect(html).toContain("I left out dates.");
  });

  it("pairs rules in order and leaves a lone trailing rule alone", () => {
    expect(sections(renderMarkdown("A\n\n---\n\nB\n\n---\n\nC\n\n---\n\nD"))).toBe(1);
    expect(sections(renderMarkdown("---\n\nB\n\n---\n\n---\n\nD\n\n---"))).toBe(2);
  });

  it("wraps nothing while the closing rule has not arrived, or between adjacent rules", () => {
    expect(sections(renderMarkdown("Intro\n\n---\n\nHi Lorenz, still streaming"))).toBe(0);
    expect(sections(renderMarkdown("A\n\n---\n\n---\n\nB"))).toBe(0);
  });
});
