/**
 * Pairing rules for the active-project tint and the composer glow, so any theme wears them
 * the same way: how strong each tinted layer is for a given sidebar surface, which colour
 * they use, and the colour maths the theme tests use to hold every theme to readable
 * contrast. Web writes the alphas as CSS variables next to the theme's palette
 * (`themePalette.ts`); `viewcode-theme.css` and `viewcode-chat.css` draw with them.
 */

/** Opacity of the tint colour in each layer it draws, from 0 to 1. */
export interface ShellTintAlphas {
  /** The sidebar background gradient, top and bottom. */
  readonly surfaceTop: number;
  readonly surfaceBottom: number;
  /** The sidebar's right edge. */
  readonly border: number;
  /** The selected chat row's fill (its 2px bar is the full colour). */
  readonly selectedRow: number;
  /** The agent tree's guide line. */
  readonly guide: number;
  /** The rail's active project fill and the folder badge fill. */
  readonly railFill: number;
  readonly badgeFill: number;
  /** The composer glow: its 1px edge, then the near and far halo. */
  readonly glowBorder: number;
  readonly glowNear: number;
  readonly glowFar: number;
}

/**
 * Drawn for a near-black sidebar. The wash is a whisper on purpose (user
 * decision): at the design's 10 % the whole left side read as a grey-tinted
 * plane, so the colour now lives on the rail tile, the badge, the edge bar
 * and the open row, and the surface only hints at it; 7.5 % was asked for
 * after 5 % read as barely there.
 */
const DARK_SURFACE: ShellTintAlphas = {
  surfaceTop: 0.075,
  surfaceBottom: 0.025,
  border: 0.25,
  selectedRow: 0.1,
  guide: 0.3,
  railFill: 0.12,
  badgeFill: 0.18,
  glowBorder: 0.45,
  glowNear: 0.28,
  glowFar: 0.12,
};

/**
 * On a light sidebar a colour reads about twice as strong, so fills and glow halve. Lines
 * keep two thirds, or a pale project colour would vanish from the edge and the tree.
 */
const LIGHT_SURFACE: ShellTintAlphas = {
  surfaceTop: 0.05,
  surfaceBottom: 0.015,
  border: 0.2,
  selectedRow: 0.07,
  guide: 0.2,
  railFill: 0.08,
  badgeFill: 0.12,
  glowBorder: 0.35,
  glowNear: 0.16,
  glowFar: 0.07,
};

// OKLab lightness where the dark values stop and the light ones are complete.
const DARK_END = 0.35;
const LIGHT_START = 0.75;

/**
 * Alphas for a sidebar surface of OKLab lightness `surfaceLightness` (0 black, 1 white):
 * the dark design up to 0.35, half strength from 0.75, eased linearly between, so mid-grey
 * themes (Solarized, Nord light) get a tint between the two.
 */
export function resolveShellTintAlphas(surfaceLightness: number): ShellTintAlphas {
  const t = Math.min(1, Math.max(0, (surfaceLightness - DARK_END) / (LIGHT_START - DARK_END)));
  const out: Record<keyof ShellTintAlphas, number> = { ...DARK_SURFACE };
  for (const key of Object.keys(DARK_SURFACE) as Array<keyof ShellTintAlphas>) {
    out[key] =
      Math.round((DARK_SURFACE[key] + (LIGHT_SURFACE[key] - DARK_SURFACE[key]) * t) * 1000) / 1000;
  }
  return out;
}

/** CSS custom property for each alpha, as `viewcode-theme.css` and `viewcode-chat.css` read them. */
export const SHELL_TINT_VARIABLES: Readonly<Record<keyof ShellTintAlphas, string>> = {
  surfaceTop: "--shell-tint-surface-top",
  surfaceBottom: "--shell-tint-surface-bottom",
  border: "--shell-tint-border",
  selectedRow: "--shell-tint-selected-row",
  guide: "--shell-tint-guide",
  railFill: "--shell-tint-rail-fill",
  badgeFill: "--shell-tint-badge-fill",
  glowBorder: "--shell-glow-border",
  glowNear: "--shell-glow-near",
  glowFar: "--shell-glow-far",
};

/** The alphas as CSS percentages, ready for `color-mix(…, var(--x), transparent)`. */
export function shellTintCssVariables(alphas: ShellTintAlphas): ReadonlyArray<[string, string]> {
  return (Object.keys(SHELL_TINT_VARIABLES) as Array<keyof ShellTintAlphas>).map((key) => [
    SHELL_TINT_VARIABLES[key],
    `${Math.round(alphas[key] * 1000) / 10}%`,
  ]);
}

/**
 * The colour the tint and the glow follow: the active project's own colour while the user
 * has the setting on and that project has one; otherwise null, meaning the theme accent
 * (and a neutral sidebar).
 */
export function resolveShellTintColor<Color>(input: {
  readonly projectColor: Color | null | undefined;
  readonly followProjectColor: boolean;
}): Color | null {
  return input.followProjectColor ? (input.projectColor ?? null) : null;
}

export type Rgb = readonly [number, number, number];

const HEX_PATTERN = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;
const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/;

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, converted)) * 255;
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** A palette colour (#rrggbb or oklch(l c h)) as sRGB channels 0–255; null otherwise. */
export function parseThemeColor(value: string): Rgb | null {
  const hex = HEX_PATTERN.exec(value.trim());
  if (hex) {
    return [
      Number.parseInt(hex[1]!, 16),
      Number.parseInt(hex[2]!, 16),
      Number.parseInt(hex[3]!, 16),
    ];
  }
  const oklch = OKLCH_PATTERN.exec(value.trim());
  if (!oklch) return null;
  const lightness = Number(oklch[1]);
  const chroma = Number(oklch[2]);
  const hue = (Number(oklch[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** OKLab lightness of an sRGB colour, 0 to 1. */
export function oklabLightness([red, green, blue]: Rgb): number {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** `color` at `alpha` over `base`, as `color-mix(in srgb, color alpha, transparent)` draws. */
export function compositeOver(color: Rgb, alpha: number, base: Rgb): Rgb {
  const channel = (index: 0 | 1 | 2) => color[index] * alpha + base[index] * (1 - alpha);
  return [channel(0), channel(1), channel(2)];
}

/** WCAG 2 contrast ratio between two opaque colours, 1 to 21. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const luminance = ([r, g, b]: Rgb) =>
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}
