import { describe, expect, it } from "vite-plus/test";

import {
  compositeOver,
  contrastRatio,
  oklabLightness,
  parseThemeColor,
  resolveShellTintAlphas,
  resolveShellTintColor,
  shellTintCssVariables,
  type Rgb,
} from "./shellTint.ts";
import {
  getThemeColorsForAppearance,
  WEB_BUILT_IN_THEMES,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalettes.ts";

describe("resolveShellTintColor", () => {
  it("follows a coloured project, else the theme accent, and never with the setting off", () => {
    expect(resolveShellTintColor({ projectColor: "teal", followProjectColor: true })).toBe("teal");
    expect(resolveShellTintColor({ projectColor: null, followProjectColor: true })).toBeNull();
    expect(resolveShellTintColor({ projectColor: "teal", followProjectColor: false })).toBeNull();
  });
});

describe("resolveShellTintAlphas", () => {
  it("uses the design's values on dark sidebars and about half on light ones", () => {
    const dark = resolveShellTintAlphas(0.2);
    const light = resolveShellTintAlphas(0.97);
    expect(dark.surfaceTop).toBe(0.05);
    expect(dark.selectedRow).toBe(0.1);
    expect(light.surfaceTop).toBeCloseTo(0.035);
    expect(light.glowNear).toBeLessThan(dark.glowNear);
    // Lines keep more than half, so a pale project colour still draws the tree.
    expect(light.guide / dark.guide).toBeGreaterThan(0.6);
  });

  it("writes each alpha as a CSS percentage", () => {
    expect(shellTintCssVariables(resolveShellTintAlphas(0.2))).toContainEqual([
      "--shell-tint-selected-row",
      "10%",
    ]);
  });

  it("eases between the two for mid-grey sidebars", () => {
    const mid = resolveShellTintAlphas(0.55);
    expect(mid.surfaceTop).toBeLessThan(0.05);
    expect(mid.surfaceTop).toBeGreaterThan(0.035);
  });
});

function rgb(colors: ThemeColors, role: keyof ThemeColors): Rgb {
  const parsed = parseThemeColor(colors[role]);
  if (!parsed) throw new Error(`${role} is not a hex or oklch colour: ${colors[role]}`);
  return parsed;
}

// The sidebar wears the theme's own roles; these are the pairs the redesign draws.
const THEMES = WEB_BUILT_IN_THEMES.flatMap((theme) =>
  (["dark", "light"] as const satisfies ReadonlyArray<ThemeAppearance>).flatMap((appearance) => {
    const colors = getThemeColorsForAppearance(theme, appearance);
    return colors ? [{ name: `${theme.label} (${appearance})`, colors }] : [];
  }),
);

describe.each(THEMES)("$name pairs with the sidebar", ({ colors }) => {
  const sidebar = rgb(colors, "sidebar");
  const accent = rgb(colors, "accent");
  const alphas = resolveShellTintAlphas(oklabLightness(sidebar));
  // The accent stands in for a project colour: the sidebar wears it when no project has one.
  const tinted = compositeOver(accent, alphas.surfaceTop, sidebar);

  it("keeps row text at 4.5:1, on the tinted surface and the selected row", () => {
    const text = rgb(colors, "sidebarForeground");
    expect(contrastRatio(text, tinted)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(text, compositeOver(accent, alphas.selectedRow, tinted)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps chip text and status marks at 3:1", () => {
    // Dots and status text draw with the foreground roles, which themes darken on light.
    for (const role of [
      "sidebarMutedForeground",
      "warningForeground",
      "errorForeground",
    ] as const) {
      expect(contrastRatio(rgb(colors, role), tinted), role).toBeGreaterThanOrEqual(3);
    }
  });

  it("tints visibly without overpowering the sidebar", () => {
    const distance = Math.hypot(...tinted.map((channel, index) => channel - sidebar[index]!));
    expect(distance).toBeGreaterThan(1.5);
    expect(contrastRatio(tinted, sidebar)).toBeLessThan(1.3);
  });
});
