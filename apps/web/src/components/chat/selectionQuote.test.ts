import { describe, expect, it } from "vite-plus/test";

import { quoteForComposer } from "./selectionQuote";

describe("quoteForComposer", () => {
  it("quotes every line and leaves room to type below", () => {
    expect(quoteForComposer(" a\n\nb ")).toBe("> a\n>\n> b\n\n");
  });
});
