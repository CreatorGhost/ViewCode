import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "./themePalettes.ts";

/**
 * Droppy Code's named themes (docs/design/droppy-look.md §4), ported onto the
 * ViewCode default through the §6.3 derivation: start from the ViewCode table
 * of the same appearance and recolour only the tint surfaces, the accent roles
 * and the status hues. Unlike the default, named themes fill the send button
 * with the accent and tint the user bubble 14 %, as Droppy does.
 *
 * Every id starts with `viewcode-`, which `viewcode-theme.css` keys on for the
 * shared glass structure. Values are computed once at module load and are
 * plain hex / rgb literals, as palette entries must be.
 */

type DroppyPalette = Readonly<{
  accent: string;
  surface: string;
  success: string;
  warning: string;
  danger: string;
}>;

type NamedThemeSpec = Readonly<{
  id: string;
  label: string;
  dark: DroppyPalette;
  light?: DroppyPalette;
}>;

const NAMED_THEME_SPECS: ReadonlyArray<NamedThemeSpec> = [
  {
    id: "viewcode-claude",
    label: "Claude",
    dark: {
      accent: "#C15F3C",
      surface: "#1A1816",
      success: "#51A556",
      warning: "#C9A227",
      danger: "#D97757",
    },
    light: {
      accent: "#C15F3C",
      surface: "#FAF9F5",
      success: "#2E7D32",
      warning: "#9A6700",
      danger: "#B3261E",
    },
  },
  {
    id: "viewcode-catppuccin",
    label: "Catppuccin",
    dark: {
      accent: "#CBA6F7",
      surface: "#1E1E2E",
      success: "#A6E3A1",
      warning: "#F9E2AF",
      danger: "#F38BA8",
    },
    light: {
      accent: "#8839EF",
      surface: "#EFF1F5",
      success: "#40A02B",
      warning: "#DF8E1D",
      danger: "#D20F39",
    },
  },
  {
    id: "viewcode-gruvbox",
    label: "Gruvbox",
    dark: {
      accent: "#FE8019",
      surface: "#282828",
      success: "#B8BB26",
      warning: "#FABD2E",
      danger: "#FB4934",
    },
    light: {
      accent: "#AF3A03",
      surface: "#FBF1C7",
      success: "#79740E",
      warning: "#B57614",
      danger: "#9D0006",
    },
  },
  {
    id: "viewcode-solarized",
    label: "Solarized",
    dark: {
      accent: "#268BD2",
      surface: "#002B36",
      success: "#859900",
      warning: "#B58900",
      danger: "#DC322F",
    },
    light: {
      accent: "#268BD2",
      surface: "#FDF6E3",
      success: "#859900",
      warning: "#B58900",
      danger: "#DC322F",
    },
  },
  {
    id: "viewcode-github",
    label: "GitHub",
    dark: {
      accent: "#4493F8",
      surface: "#0D1117",
      success: "#3FB950",
      warning: "#D29922",
      danger: "#F85149",
    },
    light: {
      accent: "#0969DA",
      surface: "#FFFFFF",
      success: "#1A7F37",
      warning: "#9A6700",
      danger: "#CF222E",
    },
  },
  {
    id: "viewcode-dracula",
    label: "Dracula",
    dark: {
      accent: "#BD93F9",
      surface: "#282A36",
      success: "#50FA7B",
      warning: "#FFB86C",
      danger: "#FF5555",
    },
  },
  {
    id: "viewcode-tokyo-night",
    label: "Tokyo Night",
    dark: {
      accent: "#7AA2F7",
      surface: "#1A1B26",
      success: "#9ECE6A",
      warning: "#E0AF68",
      danger: "#F7768E",
    },
  },
  {
    id: "viewcode-nord",
    label: "Nord",
    dark: {
      accent: "#88C0D0",
      surface: "#2E3440",
      success: "#A3BE8C",
      warning: "#EBCB8B",
      danger: "#BF616A",
    },
  },
  {
    id: "viewcode-one-dark",
    label: "One Dark",
    dark: {
      accent: "#61AFEF",
      surface: "#282C34",
      success: "#98C379",
      warning: "#E5C07B",
      danger: "#E06C75",
    },
  },
  {
    id: "viewcode-everforest",
    label: "Everforest",
    dark: {
      accent: "#A7C080",
      surface: "#2D353B",
      success: "#A7C080",
      warning: "#DBBC7F",
      danger: "#E67E80",
    },
  },
  {
    id: "viewcode-kanagawa",
    label: "Kanagawa",
    dark: {
      accent: "#7E9CD8",
      surface: "#1F1F28",
      success: "#98BB6C",
      warning: "#D7A657",
      danger: "#E82424",
    },
  },
  {
    id: "viewcode-rose-pine",
    label: "Rosé Pine",
    dark: {
      accent: "#EB6F92",
      surface: "#191724",
      success: "#9CCFD8",
      warning: "#F6C177",
      danger: "#EB6F92",
    },
  },
  {
    id: "viewcode-ayu",
    label: "Ayu",
    dark: {
      accent: "#E6B450",
      surface: "#0F1419",
      success: "#AAD94C",
      warning: "#FFB454",
      danger: "#F58572",
    },
  },
  {
    id: "viewcode-night-owl",
    label: "Night Owl",
    dark: {
      accent: "#82AAFF",
      surface: "#011627",
      success: "#C5E478",
      warning: "#ECC48D",
      danger: "#EF5350",
    },
  },
  {
    id: "viewcode-monokai",
    label: "Monokai",
    dark: {
      accent: "#F92672",
      surface: "#272822",
      success: "#A6E22E",
      warning: "#FD971F",
      danger: "#F92672",
    },
  },
  {
    id: "viewcode-codex",
    label: "Codex",
    dark: {
      accent: "#D946EF",
      surface: "#101014",
      success: "#3FB950",
      warning: "#D29922",
      danger: "#F85149",
    },
  },
  {
    id: "viewcode-cursor",
    label: "Cursor",
    dark: {
      accent: "#88C0D0",
      surface: "#181818",
      success: "#3FA266",
      warning: "#F1B467",
      danger: "#E34671",
    },
  },
  {
    id: "viewcode-matrix",
    label: "Matrix",
    dark: {
      accent: "#00E676",
      surface: "#000000",
      success: "#00E676",
      warning: "#FFD600",
      danger: "#FF5252",
    },
  },
];

/** Ids of the ported themes, reserved so a saved or published theme can't take one. */
export const VIEWCODE_NAMED_THEME_IDS: ReadonlyArray<string> = NAMED_THEME_SPECS.map(
  (spec) => spec.id,
);

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

/** sRGB mix: `weight` of `first`, the rest of `second`, like `color-mix(in srgb, …)`. */
function mix(first: Rgb, weight: number, second: Rgb): Rgb {
  return [0, 1, 2].map((index) =>
    Math.round(first[index]! * weight + second[index]! * (1 - weight)),
  ) as unknown as Rgb;
}

function withAlpha(rgb: Rgb, alpha: number): string {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha})`;
}

/** OKLab lightness, for picking a readable glyph colour on an accent fill. */
function oklabLightness([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** §6.3 derivation of one appearance of a named theme from the ViewCode table. */
export function deriveViewCodeThemeColors(
  base: ThemeColors,
  palette: DroppyPalette,
  appearance: ThemeAppearance,
): ThemeColors {
  const dark = appearance === "dark";
  const surface = hexToRgb(palette.surface);
  const accent = hexToRgb(palette.accent);
  const warning = hexToRgb(palette.warning);
  const danger = hexToRgb(palette.danger);

  const chrome = mix(surface, 0.35, hexToRgb(dark ? "#1F1F21" : "#ECECEE"));
  const canvas = mix(surface, 0.55, hexToRgb(dark ? "#18181A" : "#F7F7F8"));
  const statusForeground = (hue: Rgb) =>
    rgbToHex(dark ? mix(WHITE, 0.2, hue) : mix(BLACK, 0.15, hue));
  const onAccent = oklabLightness(accent) < 0.72 ? "#FFFFFF" : "#101010";
  const accentHex = rgbToHex(accent);

  return {
    ...base,
    chrome: rgbToHex(chrome),
    sidebar: rgbToHex(chrome),
    canvas: rgbToHex(canvas),
    surface: rgbToHex(canvas),
    toolbar: rgbToHex(canvas),
    ...(dark
      ? {
          surfaceRaised: rgbToHex(mix(WHITE, 0.05, canvas)),
          surfaceOverlay: rgbToHex(mix(WHITE, 0.06, chrome)),
          codeBackground: rgbToHex(mix(WHITE, 0.045, canvas)),
        }
      : { codeBackground: rgbToHex(mix(BLACK, 0.045, canvas)) }),
    accent: accentHex,
    focus: accentHex,
    update: accentHex,
    updateForeground: dark ? rgbToHex(mix(WHITE, 0.2, accent)) : accentHex,
    updateSurface: withAlpha(accent, dark ? 0.14 : 0.1),
    terminalCursor: accentHex,
    terminalSelection: withAlpha(accent, dark ? 0.28 : 0.18),
    accentForeground: onAccent,
    messageAction: accentHex,
    messageActionForeground: onAccent,
    messageActionHover: rgbToHex(mix(WHITE, 0.1, accent)),
    messageSurface: rgbToHex(mix(accent, 0.14, canvas)),
    error: rgbToHex(danger),
    errorForeground: statusForeground(danger),
    errorSurface: withAlpha(danger, dark ? 0.12 : 0.08),
    warning: rgbToHex(warning),
    warningForeground: statusForeground(warning),
    warningSurface: withAlpha(warning, dark ? 0.12 : 0.1),
  };
}

/** The ported themes, built on the ViewCode default's two tables. */
export function createViewCodeNamedThemes(
  base: Readonly<{ dark: ThemeColors; light: ThemeColors }>,
): ReadonlyArray<ThemeDefinition> {
  return NAMED_THEME_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    appearance: "dark",
    colors: deriveViewCodeThemeColors(base.dark, spec.dark, "dark"),
    ...(spec.light
      ? { variants: { light: deriveViewCodeThemeColors(base.light, spec.light, "light") } }
      : {}),
  }));
}
