import { describe, expect, it } from "vite-plus/test";

import { diffstatBlocks } from "./diffCount.ts";

const draw = (additions: number, deletions: number) =>
  diffstatBlocks(additions, deletions)
    .map((block) => (block === "addition" ? "+" : block === "deletion" ? "-" : "."))
    .join("");

describe("diffstatBlocks", () => {
  it("fills more blocks as the change grows, split by side", () => {
    expect(draw(0, 0)).toBe(".....");
    expect(draw(3, 0)).toBe("+....");
    expect(draw(482, 37)).toBe("+++-.");
    expect(draw(4000, 4000)).toBe("+++--");
  });

  it("gives each side that changed at least one block once there are two", () => {
    expect(draw(900, 1)).toBe("+++-.");
    expect(draw(1, 900)).toBe("+---.");
  });
});
