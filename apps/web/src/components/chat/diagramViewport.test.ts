import { describe, expect, it } from "vite-plus/test";

import {
  fitTransform,
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  wheelZoomFactor,
  zoomAround,
} from "./diagramViewport";

describe("fitTransform", () => {
  it("scales a large diagram down and centers it", () => {
    const view = fitTransform({ width: 2000, height: 500 }, { width: 1064, height: 600 }, 32);
    expect(view.scale).toBeCloseTo(0.5);
    expect(view.x).toBeCloseTo(32);
    expect(view.y).toBeCloseTo((600 - 250) / 2);
  });

  it("does not blow a small diagram up past the cap", () => {
    expect(fitTransform({ width: 100, height: 50 }, { width: 1000, height: 800 }).scale).toBe(2);
  });

  it("ignores content with no size", () => {
    expect(fitTransform({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });
});

describe("zoomAround", () => {
  it("keeps the point under the cursor fixed", () => {
    const before = { x: 40, y: -20, scale: 1.5 };
    const point = { x: 300, y: 200 };
    const after = zoomAround(before, 2, point);
    const contentPoint = (view: typeof before) => ({
      x: (point.x - view.x) / view.scale,
      y: (point.y - view.y) / view.scale,
    });
    expect(after.scale).toBe(3);
    expect(contentPoint(after).x).toBeCloseTo(contentPoint(before).x);
    expect(contentPoint(after).y).toBeCloseTo(contentPoint(before).y);
  });

  it("clamps the zoom range", () => {
    const view = { x: 0, y: 0, scale: 1 };
    expect(zoomAround(view, 1000, { x: 0, y: 0 }).scale).toBe(MAX_DIAGRAM_SCALE);
    expect(zoomAround(view, 0.0001, { x: 0, y: 0 }).scale).toBe(MIN_DIAGRAM_SCALE);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on scroll up and out on scroll down", () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
  });

  it("treats line-mode deltas like their pixel height", () => {
    expect(wheelZoomFactor(3, 1, false)).toBeCloseTo(wheelZoomFactor(48, 0, false));
  });
});
