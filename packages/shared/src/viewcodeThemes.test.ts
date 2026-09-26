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
