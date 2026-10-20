import {
  MOBILE_PALETTE_THEMES,
  T3_CHAT_THEME,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_DARK_THEME_COLORS,
  getThemeColorsForAppearance,
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_INITIAL_THEME_ID,
  MOBILE_THEME_IDS as SHARED_MOBILE_THEME_IDS,
  VIEWCODE_TEAL_THEME_ID,
  VIEWCODE_THEME_ID,
  isViewCodeThemeId,
  type MobilePaletteThemeId,
  type MobileThemeId as SharedMobileThemeId,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";

/** The standard T3 Code palette: the base Uniwind `light` and `dark` themes. */
export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;
/** What a phone wears until it picks a theme, and in place of one that no longer exists. */
export const INITIAL_MOBILE_THEME_ID: MobileThemeId = MOBILE_INITIAL_THEME_ID;
export const MOBILE_THEME_IDS = [...SHARED_MOBILE_THEME_IDS, "material-you"] as const;
export type MobileThemeId = SharedMobileThemeId | "material-you";
export type MobileThemeAppearance = ThemeAppearance;
export type MobileThemeMode = MobileThemeAppearance | "system";
export type MobileThemeIds = Readonly<Record<MobileThemeAppearance, MobileThemeId>>;

const MOBILE_THEME_APPEARANCES = ["light", "dark"] as const;

function themeAppearances(theme: ThemeDefinition): ReadonlyArray<MobileThemeAppearance> {
  return MOBILE_THEME_APPEARANCES.filter(
    (appearance) => getThemeColorsForAppearance(theme, appearance) !== null,
  );
}

/**
 * The appearances a theme has. Like desktop, a theme with one appearance can only take that half
 * of the light/dark pair.
 */
export function getMobileThemeAppearances(
  themeId: MobileThemeId,
): ReadonlyArray<MobileThemeAppearance> {
  const theme = MOBILE_PALETTE_THEMES.find((candidate) => candidate.id === themeId);
  return theme ? themeAppearances(theme) : MOBILE_THEME_APPEARANCES;
}

/** Uniwind themes registered beside the base `light` and `dark`: one per palette appearance. */
export const MOBILE_PALETTE_UNIWIND_THEME_NAMES: ReadonlyArray<`${MobilePaletteThemeId}-${MobileThemeAppearance}`> =
  MOBILE_PALETTE_THEMES.flatMap((theme) =>
    themeAppearances(theme).map(
      (appearance) => `${theme.id as MobilePaletteThemeId}-${appearance}` as const,
    ),
  );

const paletteOption = (theme: ThemeDefinition) => ({
  id: theme.id as MobileThemeId,
  label: theme.label,
});
const isViewCodeDefault = (theme: ThemeDefinition) =>
  theme.id === VIEWCODE_TEAL_THEME_ID || theme.id === VIEWCODE_THEME_ID;

/** Desktop's built-ins in desktop's order, with the standard palette and Material You after ViewCode's two. */
export const MOBILE_THEME_OPTIONS: ReadonlyArray<{
  readonly id: MobileThemeId;
  readonly label: string;
}> = [
  ...MOBILE_PALETTE_THEMES.filter(isViewCodeDefault).map(paletteOption),
  { id: DEFAULT_MOBILE_THEME_ID, label: "T3 Code" },
  { id: "material-you", label: "Material You" },
  ...MOBILE_PALETTE_THEMES.filter((theme) => !isViewCodeDefault(theme)).map(paletteOption),
];

// Closed set: every key `createMobileThemeVariables` writes. Reads of a
// misspelled variable then fail to compile instead of yielding undefined.
export type MobileThemeVariable = keyof ReturnType<typeof createMobileThemeVariables>;
export type MobileThemeVariables = Readonly<Record<MobileThemeVariable, string>>;

export function normalizeMobileThemeId(value: unknown): MobileThemeId {
  return typeof value === "string" && (MOBILE_THEME_IDS as readonly string[]).includes(value)
    ? (value as MobileThemeId)
    : INITIAL_MOBILE_THEME_ID;
}

export function normalizeMobileThemeMode(value: unknown): MobileThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveMobileThemeIds(preferences: {
  readonly themeId?: unknown;
  readonly lightThemeId?: unknown;
  readonly darkThemeId?: unknown;
}): MobileThemeIds {
  // ViewCode: a phone that never chose a theme wears the initial theme, and so does a half
  // whose theme no longer exists or lacks that appearance.
  const legacyThemeId =
    preferences.themeId === undefined
      ? INITIAL_MOBILE_THEME_ID
      : normalizeMobileThemeId(preferences.themeId);
  const resolve = (appearance: MobileThemeAppearance, stored: unknown) => {
    const themeId = stored === undefined ? legacyThemeId : normalizeMobileThemeId(stored);
    return getMobileThemeAppearances(themeId).includes(appearance)
      ? themeId
      : INITIAL_MOBILE_THEME_ID;
  };
  return {
    light: resolve("light", preferences.lightThemeId),
    dark: resolve("dark", preferences.darkThemeId),
  };
}

export function createMobileThemeSelectionPatch(
  themeIds: MobileThemeIds,
  activeAppearance: MobileThemeAppearance,
  selectedAppearance: MobileThemeAppearance,
  value: MobileThemeId,
) {
  const nextThemeIds: MobileThemeIds = {
    light: selectedAppearance === "light" ? value : themeIds.light,
    dark: selectedAppearance === "dark" ? value : themeIds.dark,
  };
  return {
    lightThemeId: nextThemeIds.light,
    darkThemeId: nextThemeIds.dark,
    // Keep older OTA bundles on the theme for the appearance currently in use.
    themeId: nextThemeIds[activeAppearance],
  };
}

export function createMobileThemePairPatch(value: MobileThemeId) {
  return {
    lightThemeId: value,
    darkThemeId: value,
    themeId: value,
  };
}

/**
 * Tapping a theme card: a theme with both appearances takes both halves; a one-appearance theme
 * takes only its own half, as on desktop.
 */
export function createMobileThemeCardPatch(
  themeIds: MobileThemeIds,
  activeAppearance: MobileThemeAppearance,
  value: MobileThemeId,
) {
  const appearances = getMobileThemeAppearances(value);
  return appearances.length === 1
    ? createMobileThemeSelectionPatch(themeIds, activeAppearance, appearances[0]!, value)
    : createMobileThemePairPatch(value);
}

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/;

function linearToSrgb(value: number): number {
  const converted = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, converted)) * 255);
}

/** React Native does not accept OKLCH ColorValues, so palettes cross the app boundary as sRGB. */
export function themeColorToNativeColor(value: string): string {
  const match = OKLCH_PATTERN.exec(value);
  if (!match) return value;

  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return alpha < 1
    ? `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(4))})`
    : `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function nativeColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(
    Object.entries(colors).map(([role, color]) => [role, themeColorToNativeColor(color)]),
  ) as ThemeColors;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length !== 6) return color;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rgbChannels(color: string): readonly [number, number, number] | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color);
  if (!match) return null;
  const [, red = "0", green = "0", blue = "0"] = match;
  return [Number.parseInt(red, 16), Number.parseInt(green, 16), Number.parseInt(blue, 16)];
}

/**
 * An opaque form of a theme colour, composited over the surface behind it. Native chip drawing
 * parses only opaque hex — an `rgba()` string falls back to a default that is nothing like the
 * colour asked for — so a translucent role like `--color-border` has to be flattened first.
 */
export function flattenThemeColor(color: string, surface: string): string {
  const alphaHex = /^#([\da-f]{6})([\da-f]{2})$/i.exec(color);
  if (alphaHex) {
    const channels = rgbChannels(color)!;
    return flattenThemeColor(
      `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Number.parseInt(alphaHex[2]!, 16) / 255})`,
      surface,
    );
  }
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(
    color.trim(),
  );
  if (!match) return color;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const behind = rgbChannels(surface) ?? [0, 0, 0];
  const channels = [match[1], match[2], match[3]].map((channel, index) =>
    Math.max(0, Math.min(255, Math.round(Number(channel) * alpha + behind[index]! * (1 - alpha)))),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function backdropRole(role: ThemeColorRole): ThemeColorRole {
  if (role.startsWith("sidebar")) return "sidebar";
  if (role.startsWith("toolbar")) return "toolbar";
  if (role.startsWith("terminal")) return "terminalBackground";
  return "canvas";
}

/**
 * A palette in opaque native colours. ViewCode's themes spell hairlines, hovers and status
 * surfaces as translucent white or black (`rgb(255 255 255 / 0.06)`), which mobile's contrast
 * checks and native drawing cannot use, so each is composited over the plane it sits on: the
 * sidebar for its rows, the toolbar for its controls, the terminal for its own roles, the canvas
 * for the rest.
 */
export function flattenMobileThemeColors(colors: ThemeColors): ThemeColors {
  const native = nativeColors(colors);
  return Object.fromEntries(
    Object.entries(native).map(([role, color]) => [
      role,
      flattenThemeColor(
        color,
        flattenThemeColor(native[backdropRole(role as ThemeColorRole)], "#000000"),
      ),
    ]),
  ) as ThemeColors;
}

function relativeLuminance(channels: readonly [number, number, number]): number {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(
  first: readonly [number, number, number],
  second: readonly [number, number, number],
): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

/** Keep the theme tint while adjusting lightness to contrast with every supplied surface. */
export function themeColorWithContrast(
  accent: string,
  surface: string | ReadonlyArray<string>,
  minimum = 4.5,
): string {
  const accentChannels = rgbChannels(accent);
  const surfaceChannels = (typeof surface === "string" ? [surface] : surface)
    .map(rgbChannels)
    .filter((channels) => channels !== null);
  const minimumContrast = (channels: readonly [number, number, number]) =>
    Math.min(...surfaceChannels.map((surface) => contrastRatio(channels, surface)));
  if (
    !accentChannels ||
    surfaceChannels.length === 0 ||
    minimumContrast(accentChannels) >= minimum
  ) {
    return accent;
  }

  const black = [0, 0, 0] as const;
  const white = [255, 255, 255] as const;
  const target = minimumContrast(black) >= minimumContrast(white) ? black : white;
  let readable: readonly [number, number, number] = target;
  let lowerAmount = 0;
  let upperAmount = 1;
  for (let index = 0; index < 12; index += 1) {
    const amount = (lowerAmount + upperAmount) / 2;
    const candidate: readonly [number, number, number] = [
      Math.round(accentChannels[0] + (target[0] - accentChannels[0]) * amount),
      Math.round(accentChannels[1] + (target[1] - accentChannels[1]) * amount),
      Math.round(accentChannels[2] + (target[2] - accentChannels[2]) * amount),
    ];
    if (minimumContrast(candidate) >= minimum) {
      readable = candidate;
      upperAmount = amount;
    } else {
      lowerAmount = amount;
    }
  }
  return `#${readable.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether two opaque colours are far enough apart to read as separate planes. */
function surfacesDiffer(first: string, second: string): boolean {
  const firstChannels = rgbChannels(themeColorToNativeColor(first));
  const secondChannels = rgbChannels(themeColorToNativeColor(second));
  return !firstChannels || !secondChannels || contrastRatio(firstChannels, secondChannels) >= 1.025;
}

export function themeColorWithAlpha(color: string, alpha: number): string {
  const channels = rgbChannels(color);
  if (channels) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(color);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

export function createMobileThemeVariables(
  colors: ThemeColors,
  appearance: MobileThemeAppearance,
  groupedCardColor = colors.surface,
) {
  const c = nativeColors(colors);
  const groupedCard = themeColorToNativeColor(groupedCardColor);
  const textSurfaces = [
    c.canvas,
    c.surface,
    c.surfaceRaised,
    c.chrome,
    c.sidebar,
    c.secondary,
    groupedCard,
  ];
  return {
    "--color-screen": c.canvas,
    "--color-sheet": withAlpha(c.chrome, 0.98),
    "--color-sheet-solid": c.chrome,
    "--color-card": c.surface,
    "--color-grouped-card": groupedCard,
    "--color-card-alt": c.surfaceRaised,
    "--color-card-translucent": withAlpha(c.surface, 0.8),
    "--color-thread-canvas": c.canvas,
    "--color-thread-selected": c.sidebarRowActive,
    "--color-thread-selected-foreground": c.sidebarForeground,
    "--color-thread-selected-foreground-muted": themeColorWithContrast(
      c.sidebarMutedForeground,
      c.sidebarRowActive,
    ),
    "--color-thread-hover": c.sidebarRowHover,
    "--color-row-hover": c.toolbarControlHover,
    "--color-composer-panel": themeColorWithAlpha(c.canvas, appearance === "dark" ? 0.92 : 0.88),
    "--color-composer-surface": themeColorWithAlpha(
      groupedCard,
      appearance === "dark" ? 0.9 : 0.94,
    ),
    "--color-composer-border": themeColorWithAlpha(
      c.border,
      groupedCard === c.surface ? (appearance === "dark" ? 0.46 : 0.54) : 0.8,
    ),
    "--color-foreground": c.text,
    "--color-foreground-secondary": themeColorWithContrast(c.textMuted, textSurfaces),
    "--color-foreground-muted": themeColorWithContrast(c.mutedForeground, textSurfaces),
    "--color-foreground-tertiary": c.secondaryLabel,
    "--color-border": c.border,
    "--color-focus": c.focus,
    "--color-border-subtle": withAlpha(c.border, 0.7),
    "--color-separator": withAlpha(c.border, 0.55),
    "--color-subtle": c.muted,
    "--color-subtle-strong": c.secondary,
    "--color-inline-skill-background": c.accentSurface,
    "--color-inline-skill-border": withAlpha(c.accent, 0.42),
    "--color-inline-skill-foreground": c.accentSurfaceForeground,
    "--color-primary": c.messageAction,
    // Some desktop accents carry a glyph below 4.5:1 (white on a mid-tone accent); mobile holds
    // labels on filled buttons to it, as it does every other text role.
    "--color-primary-foreground": themeColorWithContrast(
      c.messageActionForeground,
      c.messageAction,
    ),
    "--color-primary-text": themeColorWithContrast(c.messageAction, textSurfaces),
    "--color-primary-shadow": "#000000",
    "--color-secondary": c.secondary,
    "--color-secondary-foreground": c.secondaryForeground,
    "--color-secondary-border": c.border,
    "--color-switch-active-track": c.messageAction,
    "--color-switch-active-thumb": c.messageActionForeground,
    "--color-switch-inactive-track": c.secondary,
    "--color-switch-inactive-thumb": c.mutedForeground,
    "--color-warning": c.warningSurface,
    "--color-warning-border": withAlpha(c.warning, 0.32),
    "--color-warning-foreground": themeColorWithContrast(c.warningForeground, c.warningSurface),
    "--color-danger": c.errorSurface,
    "--color-danger-border": withAlpha(c.error, 0.32),
    "--color-danger-foreground": themeColorWithContrast(c.errorForeground, c.errorSurface),
    "--color-update": c.updateSurface,
    "--color-update-foreground": c.updateForeground,
    "--color-input": c.surface,
    "--color-input-border": c.input,
    "--color-sidebar-search": c.sidebarControlSurface,
    "--color-placeholder": themeColorWithContrast(c.placeholder, textSurfaces),
    "--color-icon": c.text,
    "--color-icon-muted": c.iconMuted,
    "--color-icon-subtle": c.secondaryLabel,
    "--color-header": withAlpha(c.toolbar, 0.97),
    "--color-header-foreground": c.toolbarForeground,
    "--color-header-border": c.toolbarBorder,
    "--color-glass-surface": withAlpha(c.surfaceOverlay, 0.74),
    "--color-glass-fallback": themeColorWithAlpha(groupedCard, appearance === "dark" ? 0.9 : 0.94),
    "--color-glass-tint": withAlpha(c.surfaceOverlay, 0.22),
    "--color-status-bar": c.canvas,
    "--color-md-body": c.text,
    "--color-md-strong": c.text,
    "--color-md-link": themeColorWithContrast(c.messageAction, c.canvas),
    "--color-md-blockquote-border": c.border,
    "--color-md-blockquote-bg": c.muted,
    "--color-md-code-bg": c.codeBackground,
    "--color-md-code-text": c.codeForeground,
    "--color-md-user-code-bg": withAlpha(c.messageForeground, 0.18),
    "--color-md-user-code-text": c.messageForeground,
    "--color-md-user-fence-bg": withAlpha("#000000", appearance === "dark" ? 0.28 : 0.16),
    "--color-md-user-fence-text": c.messageForeground,
    "--color-md-hr": c.border,
    "--color-user-bubble": c.messageSurface,
    "--color-user-bubble-foreground": c.messageForeground,
    "--color-user-bubble-foreground-muted": withAlpha(c.messageForeground, 0.78),
    "--color-user-bubble-skill-foreground": themeColorWithContrast(
      c.messageAction,
      c.messageSurface,
    ),
    "--color-backdrop": withAlpha("#000000", appearance === "dark" ? 0.48 : 0.22),
    "--color-drawer": c.sidebar,
    "--color-drawer-foreground": c.sidebarForeground,
    "--color-drawer-foreground-muted": themeColorWithContrast(c.sidebarMutedForeground, [
      c.sidebar,
      c.sidebarRowHover,
    ]),
    "--color-drawer-border": c.sidebarBorder,
    "--color-drawer-shadow": withAlpha("#000000", appearance === "dark" ? 0.32 : 0.12),
    "--color-dot-separator": withAlpha(c.textMuted, 0.35),
    "--color-wordmark": c.text,
    "--color-chevron": withAlpha(c.textMuted, 0.42),
  };
}

export const MOBILE_THEME_VARIABLE_NAMES = Object.keys(
  createMobileThemeVariables(T3_CHAT_THEME.colors, "light"),
) as ReadonlyArray<MobileThemeVariable>;

export function getMobileThemeColors(
  themeId: SharedMobileThemeId,
  appearance: MobileThemeAppearance,
): ThemeColors {
  if (themeId === DEFAULT_MOBILE_THEME_ID) {
    return appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
  }
  const theme =
    MOBILE_PALETTE_THEMES.find((candidate) => candidate.id === themeId) ?? T3_CHAT_THEME;
  return flattenMobileThemeColors(getThemeColorsForAppearance(theme, appearance) ?? theme.colors);
}

export function getMobileThemeVariables(
  themeId: SharedMobileThemeId,
  appearance: MobileThemeAppearance,
  overrides: Partial<MobileThemeVariables> | null = null,
): MobileThemeVariables {
  const colors = getMobileThemeColors(themeId, appearance);
  // Mobile settings groups and fallback materials use tonal fills where desktop
  // uses outlined cards. Raise flat or near-flat desktop surfaces above the sheet so grouped
  // content keeps a visible boundary. Regular cards retain their desktop surface. The ViewCode
  // family always raises them: on web its composer and settings groups are the one step above
  // the sheet, and Obsidian's sheet and window are close enough that the contrast test alone
  // would leave the phone's composer on the screen colour.
  const groupedCard =
    themeId === DEFAULT_MOBILE_THEME_ID
      ? appearance === "light"
        ? colors.toolbarControlHover
        : colors.sidebarRowActive
      : isViewCodeThemeId(themeId) || !surfacesDiffer(colors.surface, colors.chrome)
        ? colors.surfaceRaised
        : colors.surface;
  const mobileColors =
    themeId === DEFAULT_MOBILE_THEME_ID
      ? {
          ...colors,
          messageSurface: flattenThemeColor(
            themeColorWithAlpha(
              appearance === "dark" ? colors.sidebarRowActive : colors.border,
              0.3,
            ),
            colors.messageSurface,
          ),
        }
      : colors;
  const baseVariables = createMobileThemeVariables(mobileColors, appearance, groupedCard);

  // The complete base record guarantees that optional overrides cannot leave a token undefined.
  return overrides ? ({ ...baseVariables, ...overrides } as MobileThemeVariables) : baseVariables;
}

/** The colours a theme card's mini picture of the app paints. */
export function getMobileThemeCardColors(
  themeId: SharedMobileThemeId,
  appearance: MobileThemeAppearance,
) {
  const colors = getMobileThemeColors(themeId, appearance);
  return {
    canvas: colors.canvas,
    sidebar: colors.sidebar,
    text: colors.text,
    accent: colors.messageAction,
  };
}
