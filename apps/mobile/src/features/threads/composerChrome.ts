import type { ProjectIconColor } from "@t3tools/contracts";
import {
  oklabLightness,
  resolveShellTintAlphas,
  resolveShellTintColor,
  type Rgb,
} from "@t3tools/shared/shellTint";

import { projectAccentColor } from "../../lib/projectIcon";

/** Channels of a native colour (#rrggbb, #rrggbbaa, rgb() or rgba()); null otherwise. */
function colorChannels(value: string): Rgb | null {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(value.trim());
  if (hex) {
    return [
      Number.parseInt(hex[1]!, 16),
      Number.parseInt(hex[2]!, 16),
      Number.parseInt(hex[3]!, 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function rgba([red, green, blue]: Rgb, alpha: number): string {
  const round = (channel: number) => Math.round(channel);
  return `rgba(${round(red)}, ${round(green)}, ${round(blue)}, ${Math.round(alpha * 1000) / 1000})`;
}

function mixWithWhite([red, green, blue]: Rgb, white: number): Rgb {
  return [red + (255 - red) * white, green + (255 - green) * white, blue + (255 - blue) * white];
}

/** One ring of the glow's halo, `offset` points outside the composer's edge. */
export interface ComposerGlowHaloBand {
  readonly offset: number;
  readonly width: number;
  readonly color: string;
}

export interface ComposerGlowPaint {
  /** The glow's colour, opaque: the project's, else the theme accent. */
  readonly color: string;
  /** The composer's 1px edge while it glows. */
  readonly border: string;
  /** Stacked rings outside the edge, strongest first, standing in for web's blurred shadow. */
  readonly halo: ReadonlyArray<ComposerGlowHaloBand>;
}

const HALO_BAND_WIDTH = 3;
const HALO_BAND_COUNT = 6;

/**
 * The composer glow while a turn runs, as web draws it (`viewcode-chat.css`, "Agent live"):
 * the thread's project colour when it has one, else the theme accent, at the strengths
 * `shellTint.ts` pairs with the surface behind it. Web's near (18px) and far (48px) shadows
 * become thin rings whose alpha falls off the same way, since Android cannot draw a
 * coloured shadow on every version.
 */
export function resolveComposerGlowPaint(input: {
  readonly projectColor: ProjectIconColor | null | undefined;
  readonly appearance: "light" | "dark";
  /** The theme accent, used when the project has no colour. */
  readonly accentColor: string;
  /** The surface the composer sits on, which sets how strong the glow is drawn. */
  readonly surfaceColor: string;
}): ComposerGlowPaint {
  // Mobile has no project-colour setting: the glow always follows the project's colour.
  const projectColor = resolveShellTintColor({
    projectColor: input.projectColor,
    followProjectColor: true,
  });
  const color = projectColor
    ? projectAccentColor(projectColor, input.appearance)
    : input.accentColor;
  const channels = colorChannels(color) ?? colorChannels(input.accentColor) ?? [128, 128, 128];
  const surface = colorChannels(input.surfaceColor);
  const alphas = resolveShellTintAlphas(
    surface ? oklabLightness(surface) : input.appearance === "dark" ? 0.15 : 0.97,
  );
  const halo = Array.from({ length: HALO_BAND_COUNT }, (_, index) => {
    const distance = (index + 0.5) * HALO_BAND_WIDTH;
    const alpha =
      alphas.glowNear * 0.6 * Math.exp(-distance / 4) +
      alphas.glowFar * 0.5 * Math.exp(-distance / 10);
    return {
      offset: (index + 1) * HALO_BAND_WIDTH,
      width: HALO_BAND_WIDTH,
      color: rgba(channels, alpha),
    };
  });
  return {
    color: rgba(channels, 1),
    border: rgba(channels, alphas.glowBorder),
    halo,
  };
}

/** One slice of the running light, clockwise from the top in degrees. */
export interface LiveRingWedge {
  readonly from: number;
  readonly to: number;
  readonly color: string;
}

// Web's conic gradient: a faint tail, a white-hot head near 336deg, then a quick fade.
const LIVE_RING_STOPS: ReadonlyArray<{
  readonly at: number;
  readonly white: number;
  readonly alpha: number;
}> = [
  { at: 0, white: 0, alpha: 0 },
  { at: 180, white: 0, alpha: 0.3 },
  { at: 300, white: 0.25, alpha: 1 },
  { at: 336, white: 0.75, alpha: 1 },
  { at: 352, white: 0, alpha: 0.4 },
  { at: 360, white: 0, alpha: 0 },
];

/**
 * The running light as solid wedges, since React Native has no conic gradient: coarse
 * through the faint tail, fine through the bright head. Drawn once, then rotated.
 */
export function liveRingWedges(color: string): ReadonlyArray<LiveRingWedge> {
  const channels = colorChannels(color) ?? [128, 128, 128];
  const wedges: LiveRingWedge[] = [];
  for (let from = 0; from < 360;) {
    const step = from < 180 ? 10 : from < 300 ? 5 : 2;
    const to = Math.min(360, from + step);
    const middle = (from + to) / 2;
    const nextIndex = LIVE_RING_STOPS.findIndex((stop) => stop.at >= middle);
    const next = LIVE_RING_STOPS[nextIndex]!;
    const previous = LIVE_RING_STOPS[nextIndex - 1]!;
    const t = (middle - previous.at) / (next.at - previous.at);
    const white = previous.white + (next.white - previous.white) * t;
    const alpha = previous.alpha + (next.alpha - previous.alpha) * t;
    wedges.push({ from, to, color: rgba(mixWithWhite(channels, white), alpha) });
    from = to;
  }
  return wedges;
}

/** What the strip under the composer says about where the thread works. */
export interface ComposerCheckout {
  readonly place: "Local checkout" | "Worktree";
  /** The checked-out branch, or null outside a git repository or before it is known. */
  readonly branch: string | null;
}

export function resolveComposerCheckout(input: {
  readonly worktreePath: string | null | undefined;
  readonly threadBranch: string | null | undefined;
  readonly gitStatus: { readonly isRepo: boolean; readonly refName: string | null } | null;
}): ComposerCheckout {
  return {
    place: input.worktreePath ? "Worktree" : "Local checkout",
    branch:
      input.gitStatus?.isRepo === false
        ? null
        : (input.gitStatus?.refName ?? input.threadBranch ?? null),
  };
}
