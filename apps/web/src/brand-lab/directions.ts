import {
  VIEWCODE_THEME,
  THEME_COLOR_ROLES,
  getThemeColorsForAppearance,
  type ThemeAppearance,
} from "@t3tools/shared/themePalettes";
import { getThemeColorVariable } from "../themePalette";
import offset from "../../../../assets/brand-directions/01-offset.svg";
import cadence from "../../../../assets/brand-directions/02-cadence.svg";
import continuum from "../../../../assets/brand-directions/03-continuum.svg";
import common from "../../../../assets/brand-directions/04-common.svg";
import fold from "../../../../assets/brand-directions/05-fold.svg";
import junction from "../../../../assets/brand-directions/06-junction.svg";
import relay from "../../../../assets/brand-directions/07-relay.svg";
import aperture from "../../../../assets/brand-directions/08-aperture.svg";
import tandem from "../../../../assets/brand-directions/09-tandem.svg";
import branch from "../../../../assets/brand-directions/10-branch.svg";
import signal from "../../../../assets/brand-directions/11-signal.svg";
import pane from "../../../../assets/brand-directions/12-pane.svg";

export const marks = [
  {
    name: "Offset",
    asset: offset,
    idea: "Two viewpoints, one shared space. Open corners frame the work instead of illustrating an agent.",
    construction: "Geometric / negative space",
  },
  {
    name: "Cadence",
    asset: cadence,
    idea: "Independent threads moving at different speeds. Three strokes form a compact, recognizable rhythm.",
    construction: "Capsule matrix / asymmetric rhythm",
  },
  {
    name: "Continuum",
    asset: continuum,
    idea: "A continuous thread across a change of agent. Two overlapping curves keep the same center of gravity.",
    construction: "Continuous line / interlocking arcs",
  },
  {
    name: "Common",
    asset: common,
    idea: "An open workspace and an independent agent. The simplest expression of working together without losing autonomy.",
    construction: "Open geometry / satellite",
  },
  {
    name: "Fold",
    asset: fold,
    idea: "Two surfaces around a clear opening. Desktop and phone, different perspectives on the same work.",
    construction: "Folded planes / diagonal cuts",
  },
  {
    name: "Junction",
    asset: junction,
    idea: "A main thread with independent branches. One connecting gesture, not a literal network diagram.",
    construction: "Branching curve / modular nodes",
  },
  {
    name: "Relay",
    asset: relay,
    idea: "Two arcs pass work around a shared core. Provider handoff without losing the thread.",
    construction: "Rotational symmetry / shared center",
  },
  {
    name: "Aperture",
    asset: aperture,
    idea: "A screen with a point of focus. The phone as a window onto agents running elsewhere.",
    construction: "Framed void / offset dot",
  },
  {
    name: "Tandem",
    asset: tandem,
    idea: "Two rings sharing an overlap. Lead and child working in the same space.",
    construction: "Overlapping strokes / vesica",
  },
  {
    name: "Branch",
    asset: branch,
    idea: "A main line that forks. Child agents split off and the result comes back.",
    construction: "Stem and curve / terminal dot",
  },
  {
    name: "Signal",
    asset: signal,
    idea: "Reach from a single point. Remote control of your environment from anywhere.",
    construction: "Concentric arcs / origin dot",
  },
  {
    name: "Pane",
    asset: pane,
    idea: "Three settled tiles and one live one. A workspace where one thing is always moving.",
    construction: "Modular grid / one exception",
  },
] as const;

// Drafts stay outside the theme registry until a direction is approved.
type Swatch = readonly [
  canvas: string,
  chrome: string,
  surface: string,
  raised: string,
  text: string,
  muted: string,
  border: string,
  accent: string,
  onAccent: string,
];
export const directions = [
  {
    id: "atelier",
    name: "Atelier",
    character: "Editorial / warm / composed",
    description:
      "Chalk surfaces, ink-blue actions, a serif title and generous reading space. The sidebar stays quiet; the conversation gets room.",
    font: '"Avenir Next", "Trebuchet MS", sans-serif',
    heading: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
    radius: "18px",
    row: "9px",
    density: "11px",
    light: [
      "#f9f7f2",
      "#eeebe3",
      "#ffffff",
      "#f1eee6",
      "#252b36",
      "#606675",
      "#d5d1c7",
      "#294caf",
      "#ffffff",
    ],
    dark: [
      "#202126",
      "#17191e",
      "#272a31",
      "#30343d",
      "#eceae4",
      "#b1b4bd",
      "#484b54",
      "#acc0ff",
      "#152040",
    ],
  },
  {
    id: "instrument",
    name: "Instrument",
    character: "Technical / precise / dense",
    description:
      "Carbon and silver, compact rows, squared controls and monospaced chrome. A working instrument, not a decorative dashboard.",
    font: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    heading: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    radius: "5px",
    row: "3px",
    density: "6px",
    light: [
      "#f5f6f6",
      "#e6e9e9",
      "#ffffff",
      "#e9eded",
      "#1c272b",
      "#536269",
      "#bec9cc",
      "#2e4c58",
      "#ffffff",
    ],
    dark: [
      "#171b1e",
      "#101416",
      "#1f2528",
      "#293135",
      "#e4edef",
      "#a7b6bb",
      "#465257",
      "#c3d5db",
      "#1b2d33",
    ],
  },
  {
    id: "harbor",
    name: "Harbor",
    character: "Fluid / spacious / focused",
    description:
      "Deep marine surfaces with a restrained sea-glass accent. Softer corners and a roomy composer make long sessions feel less compressed.",
    font: '"Avenir Next", "Trebuchet MS", sans-serif',
    heading: '"Avenir Next", "Trebuchet MS", sans-serif',
    radius: "24px",
    row: "12px",
    density: "10px",
    light: [
      "#f3f8f9",
      "#e2edef",
      "#ffffff",
      "#e7f0f2",
      "#173a46",
      "#506d76",
      "#bed2d7",
      "#176c73",
      "#ffffff",
    ],
    dark: [
      "#13272e",
      "#0c1c22",
      "#19333c",
      "#24414a",
      "#e0eeef",
      "#a1bdc5",
      "#3c5963",
      "#90d8cd",
      "#103d3c",
    ],
  },
  {
    id: "linen",
    name: "Linen",
    character: "Natural / light / quiet",
    description:
      "Mineral-white surfaces and forest-green actions. Rounded humanist type, a lightly tinted sheet and less visual chrome.",
    font: '"Optima", "Candara", "Trebuchet MS", sans-serif',
    heading: '"Optima", "Candara", "Trebuchet MS", sans-serif',
    radius: "14px",
    row: "8px",
    density: "12px",
    light: [
      "#f6f8f2",
      "#e9ede2",
      "#fefff9",
      "#edf1e7",
      "#273b30",
      "#5a6c5e",
      "#c7d1bf",
      "#346647",
      "#ffffff",
    ],
    dark: [
      "#1e2822",
      "#161e19",
      "#26332a",
      "#314037",
      "#e5ece0",
      "#adbda9",
      "#4c5b4c",
      "#abd19b",
      "#243b20",
    ],
  },
  {
    id: "foundry",
    name: "Foundry",
    character: "Warm / grounded / tactile",
    description:
      "Cocoa neutrals, copper actions and strong, compact titles. Crisp edges and warmer reading surfaces, without amber everywhere.",
    font: '"Avenir Next", "Trebuchet MS", sans-serif',
    heading: '"Avenir Next Condensed", "Franklin Gothic Medium", sans-serif',
    radius: "10px",
    row: "5px",
    density: "8px",
    light: [
      "#faf5f1",
      "#eee3db",
      "#fffaf6",
      "#f1e7df",
      "#392b28",
      "#766057",
      "#d8c4b8",
      "#98472e",
      "#ffffff",
    ],
    dark: [
      "#2a211f",
      "#1d1715",
      "#332825",
      "#44342e",
      "#f1e5db",
      "#c6ada0",
      "#685047",
      "#f0af8e",
      "#492516",
    ],
  },
  {
    id: "folio",
    name: "Folio",
    character: "Graphic / architectural / clear",
    description:
      "A nearly white desk, ultramarine focus, fine rules and compact square geometry. High separation without stacks of cards.",
    font: '"Helvetica Neue", "Nimbus Sans", sans-serif',
    heading: '"Helvetica Neue", "Nimbus Sans", sans-serif',
    radius: "2px",
    row: "2px",
    density: "9px",
    light: [
      "#ffffff",
      "#edf0f7",
      "#ffffff",
      "#edf0f7",
      "#182440",
      "#5b6780",
      "#bec8dd",
      "#284fc2",
      "#ffffff",
    ],
    dark: [
      "#182034",
      "#111727",
      "#202b43",
      "#2b3752",
      "#e7edff",
      "#aebcda",
      "#4d5b78",
      "#a6bdff",
      "#172b60",
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  character: string;
  description: string;
  font: string;
  heading: string;
  radius: string;
  row: string;
  density: string;
  light: Swatch;
  dark: Swatch;
}>;

export function directionColors(
  direction: (typeof directions)[number],
  appearance: ThemeAppearance,
) {
  const [canvas, chrome, surface, raised, text, muted, border, accent, onAccent] =
    direction[appearance];
  const base = getThemeColorsForAppearance(VIEWCODE_THEME, appearance)!;
  return {
    ...base,
    canvas,
    chrome,
    surface,
    surfaceRaised: raised,
    surfaceOverlay: surface,
    toolbar: chrome,
    toolbarForeground: text,
    toolbarBorder: border,
    toolbarControl: surface,
    toolbarControlForeground: text,
    toolbarControlHover: raised,
    text,
    textMuted: muted,
    border,
    input: border,
    focus: accent,
    accent,
    accentForeground: onAccent,
    secondary: raised,
    secondaryForeground: text,
    muted: raised,
    mutedForeground: muted,
    placeholder: muted,
    secondaryLabel: muted,
    iconMuted: muted,
    accentSurface: raised,
    accentSurfaceForeground: accent,
    messageSurface: raised,
    messageForeground: text,
    messageAction: accent,
    messageActionForeground: onAccent,
    messageActionHover: accent,
    codeBackground: chrome,
    codeForeground: text,
    sidebar: chrome,
    sidebarForeground: text,
    sidebarMutedForeground: muted,
    sidebarControlSurface: surface,
    sidebarRowHover: raised,
    sidebarRowActive: raised,
    sidebarRowSelected: raised,
    sidebarBorder: border,
    terminalBackground: chrome,
    terminalForeground: text,
    terminalCursor: accent,
    terminalSelection: raised,
    terminalScrollbar: border,
    terminalScrollbarHover: muted,
  };
}

export function directionVariables(
  direction: (typeof directions)[number],
  appearance: ThemeAppearance,
) {
  const colors = directionColors(direction, appearance);
  const variables: Record<string, string> = {
    ...Object.fromEntries(
      THEME_COLOR_ROLES.map((role) => [getThemeColorVariable(role), colors[role]]),
    ),
    "--font-sans": direction.font,
    "--lab-heading": direction.heading,
    "--lab-radius": direction.radius,
    "--lab-row": direction.row,
    "--lab-density": direction.density,
    "--control-radius": direction.row,
    "--vc-row-radius": direction.row,
    "--vc-sheet-radius": direction.radius,
  };
  return variables;
}
