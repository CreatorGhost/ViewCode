import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useMemo, useSyncExternalStore } from "react";

import { cssFontFamilies } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

/** The palette `applyTheme` paints for a preference, or the stock look when no theme applies. */
function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/** A font preference's families ahead of the default stack, like the app's own CSS variables. */
function fontStack(custom: string, defaultStack: string) {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
export function useHtmlRenderTheme() {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  return useMemo(
    () =>
      htmlRenderTheme(colors, resolvedTheme, {
        sans: fontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
        mono: fontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
      }),
    [colors, resolvedTheme, sans, mono],
  );
}
