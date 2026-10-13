import { MoonIcon, SunIcon } from "lucide-react";
import type { CSSProperties } from "react";
import {
  STANDARD_THEME_PREVIEW_COLORS as SHARED_STANDARD_THEME_PREVIEW_COLORS,
  THEME_PREVIEW_RENDER_SPECS,
} from "@t3tools/shared/themePreview";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getThemeColorsForMode,
  getThemeModes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";

const THEME_PREVIEW_ROLES = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
  "text",
] as const;
type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number];
type ThemeCardPreview = {
  mode: ThemeAppearance;
  colors: Readonly<Record<ThemePreviewRole, string>>;
};
export type ThemeCardDefinition = {
  id: string;
  label: string;
  previews: ReadonlyArray<ThemeCardPreview>;
};
export type ThemeMode = ThemeAppearance | "system";
export type ThemeCardPreviewColors = ThemeCardPreview["colors"];

const STANDARD_THEME_PREVIEW_COLORS: Record<
  ThemeAppearance,
  Readonly<Record<ThemePreviewRole, string>>
> = {
  light: {
    sidebar: "#fafafa",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    messageSurface: "#e4e4e7",
    text: "#27272a",
    ...SHARED_STANDARD_THEME_PREVIEW_COLORS.light,
  },
  dark: {
    sidebar: "#0f0f10",
    surface: "#121212",
    accentSurface: "#27272a",
    messageSurface: "#27272a",
    text: "#e4e4e7",
    ...SHARED_STANDARD_THEME_PREVIEW_COLORS.dark,
  },
};

export const STANDARD_THEME_CARDS: ReadonlyArray<ThemeCardDefinition> = [
  {
    id: "default",
    label: "T3 Code",
    previews: (["light", "dark"] as const).map((mode) => ({
      mode,
      colors: STANDARD_THEME_PREVIEW_COLORS[mode],
    })),
  },
];

export function previewColorsOf(
  card: ThemeCardDefinition,
  mode: ThemeAppearance,
): ThemeCardPreviewColors | null {
  return card.previews.find((preview) => preview.mode === mode)?.colors ?? null;
}

export function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    previews: getThemeModes(theme).map((mode) => {
      const colors = getThemeColorsForMode(theme, mode) ?? theme.colors;
      return {
        mode,
        colors: {
          sidebar: colors.sidebar,
          canvas: colors.canvas,
          surface: colors.surface,
          accentSurface: colors.accentSurface,
          accent: colors.accent,
          messageSurface: colors.messageSurface,
          messageAction: colors.messageAction,
          text: colors.text,
        },
      };
    }),
  };
}

// Interpolating in oklab keeps the glow falloff perceptually even (no gray
// mid-tones or banding rings), and premultiplied alpha keeps the fade to
// transparent clean.
function getThemePreviewStyle(
  colors: ThemeCardPreviewColors,
  mode: ThemeAppearance,
): CSSProperties {
  const spec = THEME_PREVIEW_RENDER_SPECS[mode];
  // The canvas carries the ball's light/dark identity, so it stays dominant:
  // a near-true base with a contained accent glow, instead of an accent wash
  // that makes both modes read alike.
  const modeBase = `color-mix(in oklab, ${colors.canvas} ${spec.baseWeight * 100}%, ${spec.baseTarget})`;
  const accentPosition = `${spec.accent.center[0] * 100}% ${spec.accent.center[1] * 100}%`;
  const actionPosition = `${spec.action.center[0] * 100}% ${spec.action.center[1] * 100}%`;
  return {
    backgroundColor: modeBase,
    backgroundImage: [
      `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${spec.accent.middleOpacity * 100}%, transparent) ${spec.accent.middleOffset * 100}%, transparent ${spec.accent.endOffset * 100}%)`,
      // The action color is a soft tint from the opposite corner, not a second
      // light source — two bright hotspots read as headlights.
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} ${spec.action.startOpacity * 100}%, transparent) 0%, transparent ${spec.action.endOffset * 100}%)`,
    ].join(", "),
  };
}

// The gradient halves of each ball can match the card surface, so every ball
// carries a faint mode-appropriate inner ring to keep its silhouette legible.
function themePreviewEdgeShadow(mode: ThemeAppearance): string {
  return mode === "dark"
    ? "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)"
    : "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)";
}

export function ThemePreviewCircle({
  colors,
  mode,
  className,
}: {
  colors: ThemeCardPreviewColors;
  mode: ThemeAppearance;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background",
        className,
      )}
      style={{ boxShadow: themePreviewEdgeShadow(mode) }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{
          ...getThemePreviewStyle(colors, mode),
          filter: `blur(${THEME_PREVIEW_RENDER_SPECS[mode].blurAt56Px}px)`,
          transform: `scale(${THEME_PREVIEW_RENDER_SPECS[mode].scale})`,
        }}
      />
    </span>
  );
}

/**
 * Sun and moon over a two-appearance theme card's preview: each assigns the theme to that half
 * of the appearance mix. They show on hover or focus, and stay while the theme owns a half,
 * marking which.
 */
export function ThemeModePicks({
  label,
  activeModes,
  onSelectMode,
}: {
  label: string;
  activeModes: ReadonlyArray<ThemeMode>;
  onSelectMode: (mode: ThemeMode) => void;
}) {
  const anyPicked = activeModes.some((mode) => mode !== "system");
  return (
    <div
      className={cn(
        "absolute right-1 bottom-1 flex gap-0.5 transition-opacity group-focus-within/theme-card:opacity-100 group-hover/theme-card:opacity-100",
        anyPicked ? "opacity-100" : "opacity-0",
      )}
    >
      {(["light", "dark"] as const).map((mode) => {
        const isPicked = activeModes.includes(mode);
        const Icon = mode === "light" ? SunIcon : MoonIcon;
        return (
          <Tooltip key={mode}>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Use ${label} for ${mode} mode only`}
                  aria-pressed={isPicked}
                  className={cn(
                    "flex size-5 cursor-pointer items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isPicked
                      ? "border-transparent bg-foreground text-background"
                      : "border-border/70 bg-background/80 text-muted-foreground hover:text-foreground",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectMode(mode);
                  }}
                  type="button"
                >
                  <Icon className="size-3" />
                </button>
              }
            />
            <TooltipPopup>
              {mode === "light" ? "Use for light mode only" : "Use for dark mode only"}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * A one-appearance theme's mark over its preview: the moon (or sun) it is for, filled while the
 * theme holds that half. Picking such a theme in the other mode changes nothing on screen, so
 * this is its feedback.
 */
export function ThemeOnlyBadge({ mode, picked }: { mode: ThemeAppearance; picked: boolean }) {
  const Icon = mode === "light" ? SunIcon : MoonIcon;
  return (
    <span
      className={cn(
        "pointer-events-none absolute right-1 bottom-1 inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium",
        picked
          ? "border-transparent bg-foreground text-background"
          : "border-border/70 bg-background/80 text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-3" />
      {mode === "light" ? "Light only" : "Dark only"}
    </span>
  );
}
