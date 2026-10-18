import { describe, expect, it } from "vite-plus/test";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "./reserved-regions";
import { deriveLayout, deriveWorkspacePaneLayout } from "./layout";

const innerDisplay: NativeLayoutMetrics = {
  width: 960,
  height: 560,
  horizontalSizeClass: "regular",
  verticalBarEdge: "right",
  safeArea: { top: 0, bottom: 20, left: 8, right: 72 },
  reservedRegions: [],
};

describe("bottom controls around reserved regions", () => {
  it("respects asymmetric side controls without reserving the bottom twice", () => {
    expect(deriveBottomControlInsets(innerDisplay)).toEqual({ left: 8, right: 72, bottom: 0 });
  });

  it("leaves ordinary non-native clients unchanged", () => {
    expect(deriveBottomControlInsets(null)).toEqual({ left: 0, right: 0, bottom: 0 });
  });

  it("keeps the editor entirely on one side of a book fold", () => {
    const insets = deriveBottomControlInsets({
      ...innerDisplay,
      reservedRegions: [{ kind: "division", x: 456, y: 0, width: 48, height: 560 }],
    });
    expect(insets).toEqual({ left: 8, right: 504, bottom: 0 });
    expect(innerDisplay.width - insets.left - insets.right).toBeGreaterThan(320);
  });

  it("keeps controls below a horizontal fold in a hands-free pose", () => {
    expect(
      deriveBottomControlInsets({
        ...innerDisplay,
        reservedRegions: [{ kind: "division", x: 0, y: 240, width: 960, height: 40 }],
      }),
    ).toEqual({ left: 8, right: 72, bottom: 0 });
  });

  it("moves a control away from a bottom camera while leaving a top camera alone", () => {
    expect(
      deriveBottomControlInsets({
        ...innerDisplay,
        reservedRegions: [
          { kind: "occlusion", x: 8, y: 0, width: 60, height: 60 },
          { kind: "occlusion", x: 8, y: 510, width: 60, height: 50 },
        ],
      }),
    ).toEqual({ left: 68, right: 72, bottom: 0 });
  });

  it("restores the full editor width when the device opens flat", () => {
    const folded = {
      ...innerDisplay,
      reservedRegions: [{ kind: "division" as const, x: 456, y: 0, width: 48, height: 560 }],
    };
    expect(deriveBottomControlInsets(folded)).not.toEqual(deriveBottomControlInsets(innerDisplay));
    expect(deriveBottomControlInsets(innerDisplay)).toEqual({ left: 8, right: 72, bottom: 0 });
  });
});

describe("ViewCode workspace sizing on foldable displays", () => {
  it("keeps the existing compact screen on a short regular-width inner display", () => {
    const layout = deriveLayout({ ...innerDisplay, nativeMetrics: innerDisplay });
    expect(layout.usesSplitView).toBe(false);
    expect(layout.listPaneWidth).toBeNull();
    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: innerDisplay.width,
        primarySidebarPreferredVisible: true,
        auxiliaryPanePreferredVisible: false,
      }).contentPaneWidth,
    ).toBe(960);
  });

  it("keeps an ordinary phone compact when it rotates", () => {
    expect(deriveLayout({ width: 852, height: 393 }).usesSplitView).toBe(false);
    for (const [width, height] of [
      [932, 430],
      [650, 500],
    ]) {
      const metrics: NativeLayoutMetrics = {
        ...innerDisplay,
        width: width!,
        height: height!,
        verticalBarEdge: "none",
        safeArea: { top: 0, bottom: 20, left: 59, right: 59 },
      };
      expect(deriveLayout({ ...metrics, nativeMetrics: metrics }).usesSplitView).toBe(false);
      const cameraMetrics = {
        ...metrics,
        reservedRegions: [{ kind: "occlusion" as const, x: 0, y: 0, width: 60, height: 60 }],
      };
      expect(deriveLayout({ ...cameraMetrics, nativeMetrics: cameraMetrics }).usesSplitView).toBe(
        false,
      );
    }
    expect(
      deriveLayout({
        width: 960,
        height: 560,
        nativeMetrics: {
          ...innerDisplay,
          horizontalSizeClass: "compact",
        },
      }).usesSplitView,
    ).toBe(false);
  });

  it("keeps a narrow unfolded portrait display on the existing compact screen", () => {
    // Reported by the iOS 27.1 Duo simulator: no side bar or fold, only the hinge.
    const portrait: NativeLayoutMetrics = {
      width: 669,
      height: 951,
      hasHinge: true,
      horizontalSizeClass: "regular",
      verticalBarEdge: "none",
      safeArea: { top: 82, bottom: 34, left: 0, right: 0 },
      reservedRegions: [{ kind: "occlusion", x: 535, y: 0, width: 134, height: 82 }],
    };
    const portraitLayout = deriveLayout({ ...portrait, nativeMetrics: portrait });
    expect(portraitLayout.usesSplitView).toBe(false);
    expect(portraitLayout.listPaneWidth).toBeNull();
    // Without the hinge, the same window is an ordinary narrow iPad-style window.
    const withoutHinge = { ...portrait, hasHinge: false };
    expect(deriveLayout({ ...withoutHinge, nativeMetrics: withoutHinge })).toEqual(portraitLayout);
  });

  it("keeps the folded front screen compact in both orientations", () => {
    for (const [width, height] of [
      [466, 678],
      [678, 466],
    ]) {
      const folded: NativeLayoutMetrics = {
        width: width!,
        height: height!,
        hasHinge: true,
        horizontalSizeClass: "compact",
        verticalBarEdge: "right",
        safeArea: { top: 0, bottom: 34, left: 0, right: 84 },
        reservedRegions: [],
      };
      expect(deriveLayout({ ...folded, nativeMetrics: folded }).usesSplitView).toBe(false);
    }
  });

  it("requires enough safe width for both panes in a multitasking window", () => {
    const metrics = { ...innerDisplay, width: 660 };
    expect(deriveLayout({ ...metrics, nativeMetrics: metrics }).usesSplitView).toBe(false);
  });

  it("keeps the compact workspace full width while controls avoid a book fold", () => {
    const metrics = {
      ...innerDisplay,
      reservedRegions: [{ kind: "division" as const, x: 456, y: 0, width: 48, height: 560 }],
    };
    const layout = deriveLayout({ ...metrics, nativeMetrics: metrics });
    expect(layout.usesSplitView).toBe(false);
    expect(layout.listPaneWidth).toBeNull();
    expect(deriveBottomControlInsets(metrics)).toEqual({ left: 8, right: 504, bottom: 0 });
    const panes = deriveWorkspacePaneLayout({
      layout,
      viewportWidth: 960,
      primarySidebarPreferredVisible: true,
      auxiliaryPanePreferredVisible: false,
    });
    expect(panes.primarySidebarVisible).toBe(false);
    expect(panes.contentPaneWidth).toBe(960);
    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 960,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: false,
      }).contentPaneWidth,
    ).toBe(960);
  });
});
