import { describe, expect, it } from "vite-plus/test";

import {
  buildMermaidTheme,
  contrastRatio,
  deriveDiagramPalette,
  diagramPaletteSignature,
  type DiagramTokens,
  flattenColor,
  groupHueCycle,
  mermaidRenderKey,
  parseCssColor,
  planFlowchartTones,
} from "./mermaidTheme";

const rgb = (hex: string) => {
  const color = parseCssColor(hex);
  if (!color) throw new Error(`bad color ${hex}`);
  return { r: color.r, g: color.g, b: color.b };
};

// ViewCode dark and light, as the document resolves them.
const DARK_TOKENS: DiagramTokens = {
  canvas: rgb("#19191b"),
  text: rgb("#dededf"),
  muted: rgb("#999999"),
  border: flattenColor({ r: 255, g: 255, b: 255, a: 0.08 }, rgb("#19191b")),
  accent: rgb("#e0a15a"),
  warning: rgb("#c9b037"),
  danger: rgb("#e5675f"),
};

const LIGHT_TOKENS: DiagramTokens = {
  canvas: rgb("#ffffff"),
  text: rgb("#1d1d1f"),
  muted: rgb("#6e6e73"),
  border: rgb("#e5e5e7"),
  accent: rgb("#3b6fd9"),
  warning: rgb("#b7791f"),
  danger: rgb("#d64545"),
};

describe("parseCssColor", () => {
  it("reads the formats getComputedStyle returns", () => {
    expect(parseCssColor("rgb(25, 25, 27)")).toEqual({ r: 25, g: 25, b: 27, a: 1 });
    expect(parseCssColor("rgba(255, 255, 255, 0.08)")).toEqual({ r: 255, g: 255, b: 255, a: 0.08 });
    expect(parseCssColor("rgb(255 255 255 / 8%)")).toEqual({ r: 255, g: 255, b: 255, a: 0.08 });
    expect(parseCssColor("color(srgb 1 0.5 0 / 0.5)")).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
    expect(parseCssColor("#E0A15A")).toEqual({ r: 224, g: 161, b: 90, a: 1 });
    expect(parseCssColor("#fff8")).toEqual({ r: 255, g: 255, b: 255, a: 136 / 255 });
  });

  it("leaves other color spaces to the canvas fallback", () => {
    expect(parseCssColor("oklch(0.7 0.1 60)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("#12345")).toBeNull();
  });
});

describe("deriveDiagramPalette", () => {
  it("detects the appearance from the canvas", () => {
    expect(deriveDiagramPalette(DARK_TOKENS, "Inter").dark).toBe(true);
    expect(deriveDiagramPalette(LIGHT_TOKENS, "Inter").dark).toBe(false);
  });

  it("keeps node and group text readable in both appearances", () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      const palette = deriveDiagramPalette(tokens, "Inter");
      const text = rgb(palette.text);
      for (const tone of [palette.base, palette.note, ...Object.values(palette.tones)]) {
        expect(contrastRatio(rgb(tone.fill), text)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(rgb(tone.clusterFill), rgb(tone.clusterText))).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      expect(contrastRatio(rgb(palette.edgeLabel), rgb(palette.muted))).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps fills soft: closer to the canvas than their strokes", () => {
    const palette = deriveDiagramPalette(LIGHT_TOKENS, "Inter");
    const canvas = rgb(palette.canvas);
    for (const tone of Object.values(palette.tones)) {
      expect(contrastRatio(rgb(tone.fill), canvas)).toBeLessThan(
        contrastRatio(rgb(tone.stroke), canvas),
      );
    }
  });

  it("changes the cache key when the theme or font changes", () => {
    const source = "flowchart LR\n  A --> B";
    const dark = diagramPaletteSignature(deriveDiagramPalette(DARK_TOKENS, "Inter"));
    const light = diagramPaletteSignature(deriveDiagramPalette(LIGHT_TOKENS, "Inter"));
    const otherFont = diagramPaletteSignature(deriveDiagramPalette(DARK_TOKENS, "Georgia"));
    expect(mermaidRenderKey(source, dark)).not.toBe(mermaidRenderKey(source, light));
    expect(mermaidRenderKey(source, dark)).not.toBe(mermaidRenderKey(source, otherFont));
    expect(mermaidRenderKey(`\n${source}\n\n`, dark)).toBe(mermaidRenderKey(source, dark));
  });
});

describe("groupHueCycle", () => {
  it("drops the palette hue that would read as the accent", () => {
    expect(groupHueCycle(rgb("#e0a15a"))).not.toContain("amber");
    expect(groupHueCycle(rgb("#3b6fd9"))).not.toContain("blue");
  });

  it("keeps every hue for a neutral accent", () => {
    expect(groupHueCycle(rgb("#8a8a8c"))).toHaveLength(6);
  });
});

describe("buildMermaidTheme", () => {
  it("uses the app font and turns off Mermaid's gradients and shadows", () => {
    const { themeVariables, themeCSS } = buildMermaidTheme(
      deriveDiagramPalette(DARK_TOKENS, "Inter, sans-serif"),
    );
    expect(themeVariables).toMatchObject({
      fontFamily: "Inter, sans-serif",
      darkMode: true,
      useGradient: false,
      dropShadow: "none",
    });
    expect(themeCSS).toContain(".node.vcToneBlue > rect");
    expect(themeCSS).not.toMatch(/url\(/);
  });
});

describe("planFlowchartTones", () => {
  const cycle = groupHueCycle(rgb("#8a8a8c"));

  it("gives each group its own tone, innermost group first", () => {
    expect(
      planFlowchartTones(
        {
          subgraphs: [
            { id: "inner", nodes: ["B"], styled: false },
            { id: "outer", nodes: ["A", "B", "inner"], styled: false },
            { id: "other", nodes: ["C"], styled: false },
          ],
          vertices: [
            { id: "A", shape: "square", styled: false },
            { id: "B", shape: "square", styled: false },
            { id: "C", shape: "square", styled: false },
          ],
        },
        cycle,
      ),
    ).toEqual([
      "class inner,B vcToneBlue",
      "class outer,A vcToneAmber",
      "class other,C vcToneTeal",
    ]);
  });

  it("colours decisions, terminals and stores outside groups, and nothing the author styled", () => {
    expect(
      planFlowchartTones(
        {
          subgraphs: [],
          vertices: [
            { id: "start", shape: "stadium", styled: false },
            { id: "check", shape: "diamond", styled: false },
            { id: "db", shape: "cylinder", styled: false },
            { id: "step", shape: "square", styled: false },
            { id: "custom", shape: "diamond", styled: true },
          ],
        },
        cycle,
      ),
    ).toEqual(["class start vcToneGreen", "class check vcToneAmber", "class db vcToneViolet"]);
  });

  it("falls back to the next role hue when the accent took the first", () => {
    const amberAccentCycle = groupHueCycle(rgb("#e0a15a"));
    expect(
      planFlowchartTones(
        { subgraphs: [], vertices: [{ id: "check", shape: "diamond", styled: false }] },
        amberAccentCycle,
      ),
    ).toEqual(["class check vcToneViolet"]);
  });
});
