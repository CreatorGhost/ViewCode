import { describe, expect, it } from "vite-plus/test";

import {
  captureMatchesBounds,
  planWindowCapture,
  pngDimensions,
  type QuartzWindow,
} from "./MacQuartz.ts";
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

describe("planWindowCapture", () => {
  const bounds = { x: 100, y: 80, width: 800, height: 600 };
  const target: QuartzWindow = { pid: 7, layer: 0, alpha: 1, id: 41, bounds };
  const menu: QuartzWindow = {
    pid: 7,
    layer: 101,
    alpha: 1,
    id: 42,
    bounds: { x: 300, y: 200, width: 220, height: 400 },
  };
  const other = (rect: QuartzWindow["bounds"], alpha = 1): QuartzWindow => ({
    pid: 9,
    layer: 0,
    alpha,
    id: 90,
    bounds: rect,
  });

  it("captures the screen region, menus included, when no other app overlaps", () => {
    expect(planWindowCapture([target], 7, bounds)).toEqual({ kind: "region", id: 41 });
    expect(planWindowCapture([menu, target], 7, bounds)).toEqual({ kind: "region", id: 41 });
    expect(
      planWindowCapture([other({ x: 1000, y: 80, width: 300, height: 300 }), target], 7, bounds),
    ).toEqual({ kind: "region", id: 41 });
    expect(planWindowCapture([target, other(bounds)], 7, bounds)).toEqual({
      kind: "region",
      id: 41,
    });
    expect(planWindowCapture([other(bounds, 0), target], 7, bounds)).toEqual({
      kind: "region",
      id: 41,
    });
  });

  it("captures only the window's own pixels when another app covers part of it", () => {
    expect(
      planWindowCapture(
        [other({ x: 850, y: 600, width: 300, height: 300 }), menu, target],
        7,
        bounds,
      ),
    ).toEqual({ kind: "window", id: 41 });
  });

  it("refuses when the window is not on this desktop or cannot be told apart", () => {
    expect(planWindowCapture([menu], 7, bounds)).toBeNull();
    expect(planWindowCapture([target, { ...target, id: 43 }], 7, bounds)).toBeNull();
    expect(planWindowCapture([{ ...target, pid: 8 }], 7, bounds)).toBeNull();
  });
});
