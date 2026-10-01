import { describe, expect, it } from "vite-plus/test";
import {
  THEME_COLOR_ROLES,
  VIEWCODE_THEME,
  getThemeColorsForAppearance,
} from "@t3tools/shared/themePalettes";
import { getThemeColorVariable, isThemeColor } from "../themePalette";
import { directionColors, directions, directionVariables } from "./directions";

function luminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

describe("brand lab draft palettes", () => {
  for (const direction of directions) {
    for (const appearance of ["light", "dark"] as const) {
      it(`${direction.name} ${appearance} maps every role without mutating the production palette`, () => {
        const base = getThemeColorsForAppearance(VIEWCODE_THEME, appearance)!;
        const original = { ...base };
        const colors = directionColors(direction, appearance);
        const variables = directionVariables(direction, appearance);
        for (const role of THEME_COLOR_ROLES) {
          expect(isThemeColor(colors[role]), role).toBe(true);
          expect(variables[getThemeColorVariable(role)]).toBe(colors[role]);
        }
        expect(base).toEqual(original);
        for (const surface of [
          colors.canvas,
          colors.chrome,
          colors.surface,
          colors.surfaceRaised,
        ]) {
          expect(contrast(colors.text, surface), "body contrast").toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(colors.textMuted, surface),
            "secondary text contrast",
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrast(colors.messageAction, colors.messageActionForeground),
          "action contrast",
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.focus, colors.canvas), "focus contrast").toBeGreaterThanOrEqual(3);
      });
    }
  }
});
