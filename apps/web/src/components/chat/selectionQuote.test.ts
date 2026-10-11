import { describe, expect, it } from "vite-plus/test";

import { quoteForComposer, SELECTION_PREVIEW_MAX_LENGTH } from "./selectionQuote";

describe("quoteForComposer", () => {
  it("leaves a short selection whole, with a blank line below to type on", () => {
    expect(quoteForComposer("Cloud Spanner")).toBe("> Cloud Spanner\n\n");
  });

  it("collapses lines, blank lines and runs of whitespace onto one quoted line", () => {
    expect(quoteForComposer(" a\n\n  b\tc ")).toBe("> a b c\n\n");
  });

  it("keeps a `>` already in the text inside the single quote line", () => {
    expect(quoteForComposer("> earlier\n> quote")).toBe("> > earlier > quote\n\n");
  });

  it("truncates a long selection with an ellipsis", () => {
    const text = "Three databases: Cloud Spanner (shared) — the opportunity tab and more after";
    expect(text.length).toBeGreaterThan(SELECTION_PREVIEW_MAX_LENGTH);
    expect(quoteForComposer(text)).toBe(`> ${text.slice(0, SELECTION_PREVIEW_MAX_LENGTH)}…\n\n`);
  });
});
