import { describe, expect, it } from "@effect/vitest";

import { VIEWCODE_THEME, WEB_BUILT_IN_THEMES, RESERVED_THEME_IDS } from "./themePalettes.ts";
import { VIEWCODE_NAMED_THEME_IDS } from "./viewcodeThemes.ts";

function themeById(id: string) {
  const theme = WEB_BUILT_IN_THEMES.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`missing theme ${id}`);
  return theme;
}

describe("ViewCode named themes", () => {
  it("derives Claude from the ViewCode tables as the design spec precomputes it", () => {
    const claude = themeById("viewcode-claude");
    expect(claude.colors).toMatchObject({
      chrome: "#1D1D1D",
      sidebar: "#1D1D1D",
      canvas: "#191818",
      surface: "#191818",
      surfaceOverlay: "#2B2B2B",
      codeBackground: "#232222",
      accent: "#C15F3C",
      accentForeground: "#FFFFFF",
      messageAction: "#C15F3C",
      messageActionHover: "#C76F50",
      messageSurface: "#31221D",
      error: "#D97757",
      warning: "#C9A227",
    });
    expect(claude.variants?.light).toMatchObject({
      chrome: "#F1F1F0",
      sidebar: "#F1F1F0",
      canvas: "#F9F8F6",
      codeBackground: "#EEEDEB",
      accent: "#C15F3C",
      messageSurface: "#F1E3DC",
      error: "#B3261E",
      warning: "#9A6700",
    });
  });

  it("keeps hover, selection and borders on the neutral ViewCode values", () => {
    const claude = themeById("viewcode-claude");
    for (const role of [
      "sidebarRowHover",
      "sidebarRowSelected",
      "border",
      "accentSurface",
    ] as const) {
      expect(claude.colors[role]).toBe(VIEWCODE_THEME.colors[role]);
    }
  });

  it("picks a dark glyph on light accents", () => {
    expect(themeById("viewcode-matrix").colors.messageActionForeground).toBe("#101010");
  });

  it("reserves every ported id and namespaces it for viewcode-theme.css", () => {
    for (const id of VIEWCODE_NAMED_THEME_IDS) {
      expect(id.startsWith("viewcode-")).toBe(true);
      expect(RESERVED_THEME_IDS.has(id)).toBe(true);
    }
  });
});

/** WCAG 2 contrast ratio of two `#RRGGBB` colours. */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].toSorted(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

describe("ViewCode default contrast", () => {
  const appearances = {
    dark: VIEWCODE_THEME.colors,
    light: { ...VIEWCODE_THEME.colors, ...VIEWCODE_THEME.variants?.light },
  };
  const textSurfaces = ["canvas", "surface", "surfaceRaised", "surfaceOverlay"] as const;

  for (const [appearance, colors] of Object.entries(appearances)) {
    it(`keeps secondary text at 4.5:1 and placeholders at 3.5:1 (${appearance})`, () => {
      for (const surface of textSurfaces) {
        for (const role of ["textMuted", "mutedForeground", "secondaryLabel"] as const) {
          expect(contrastRatio(colors[role], colors[surface])).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(colors.placeholder, colors[surface])).toBeGreaterThanOrEqual(3.5);
      }
      expect(contrastRatio(colors.sidebarMutedForeground, colors.sidebar)).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  }
});
