import { describe, expect, it } from "vite-plus/test";

import { resolveProjectIconGlyph } from "./projectIcon";

describe("resolveProjectIconGlyph", () => {
  it("draws web's popular Lucide icons with their color", () => {
    expect(
      resolveProjectIconGlyph({ kind: "lucide", name: "rocket", color: "violet" }, "App"),
    ).toEqual({ kind: "lucide", name: "rocket", color: "violet" });
  });

  it("falls back to a colored monogram for Lucide icons mobile lacks", () => {
    expect(
      resolveProjectIconGlyph({ kind: "lucide", name: "tractor", color: "green" }, "Farm app"),
    ).toEqual({ kind: "monogram", text: "FA", color: "green" });
  });
});
