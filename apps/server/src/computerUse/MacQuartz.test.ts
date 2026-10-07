import { describe, expect, it } from "vite-plus/test";

import { pngDimensions } from "./MacQuartz.ts";
import { encodePng } from "./ScreenshotImage.ts";

describe("pngDimensions", () => {
  it("reads a PNG's size and rejects anything else", () => {
    expect(pngDimensions(encodePng(new Uint8Array(3 * 2 * 4), 3, 2))).toEqual({
      width: 3,
      height: 2,
    });
    expect(pngDimensions(new TextEncoder().encode("not a png at all, really"))).toBeNull();
    expect(pngDimensions(new Uint8Array(8))).toBeNull();
  });
});
