import type { ThemeName } from "uniwind";

import { resolveTextScaleVariables } from "./appearancePreferences";
import {
  DEFAULT_MOBILE_THEME_ID,
  MOBILE_PALETTE_UNIWIND_THEME_NAMES,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

/**
 * A registered Uniwind theme. One-appearance palettes register only that appearance, and
 * `resolveMobileThemeIds` never puts one on the other half, so names are built, not looked up.
 */
export type MobileUniwindThemeName = ThemeName;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES = [
  "light",
  "dark",
  ...MOBILE_PALETTE_UNIWIND_THEME_NAMES,
] as ReadonlyArray<MobileUniwindThemeName>;

export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return (
    themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you"
      ? appearance
      : `${themeId}-${appearance}`
  ) as MobileUniwindThemeName;
}

/**
 * Plans imperative runtime work separately from theme selection. Palette
 * changes are handled by one root ScopedTheme render; only typography and the
 * native appearance override need imperative Uniwind/React Native updates.
 */
export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
