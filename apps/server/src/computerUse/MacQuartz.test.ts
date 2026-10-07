import { describe, expect, it } from "vite-plus/test";

import { captureMatchesBounds, pngDimensions } from "./MacQuartz.ts";
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

describe("window capture geometry", () => {
  const bounds = { x: 100, y: 80, width: 660, height: 725 };

  it("accepts native and Retina pixels at the window's aspect ratio", () => {
    expect(captureMatchesBounds({ width: 660, height: 725 }, bounds)).toBe(true);
    expect(captureMatchesBounds({ width: 1320, height: 1450 }, bounds)).toBe(true);
  });

  it("rejects Freeform's capture extended by an attached overflow menu", () => {
    expect(captureMatchesBounds({ width: 1736, height: 1450 }, bounds)).toBe(false);
  });

  it("allows pixel rounding but refuses a differently shaped capture", () => {
    expect(captureMatchesBounds({ width: 1321, height: 1450 }, bounds)).toBe(true);
    expect(captureMatchesBounds({ width: 1568, height: 1309 }, bounds)).toBe(false);
  });

  it("refuses empty window or capture bounds", () => {
    expect(captureMatchesBounds({ width: 0, height: 0 }, bounds)).toBe(false);
    expect(captureMatchesBounds({ width: 1320, height: 1450 }, { ...bounds, width: 0 })).toBe(
      false,
    );
  });
});
