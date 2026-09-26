/**
 * The effort slider's looks and its live track effect, ported from Droppy
 * Code's EffortSlider (TrackLook, EffortBrand, EffortPalette, TrackEffect).
 *
 * Four modes, each distinct: standard (a solid blue per level, still), fast
 * (gold with speed streaks), max (the provider's brand with drifting sparks
 * and small crackling arcs) and fusion (max and fast together: brand into
 * gold, sparks, streaks, big lightning, a sweeping sheen and a flare at the
 * knob).
 */
import type { ProviderDriverKind } from "@t3tools/contracts";

export type Rgb = readonly [number, number, number];

export function rgba(color: Rgb, alpha = 1): string {
  const [r, g, b] = color.map((channel) => Math.round(channel * 255));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.max(alpha, 0)})`;
}

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

/** Fast mode's gold: the bolt's yellow, and a deeper one for fills. */
export const FAST_TITLE: Rgb = [1, 0.84, 0.36];
export const FAST_FILL: Rgb = [0.93, 0.66, 0.13];

const GEMINI: ReadonlyArray<Rgb> = [
  [0.26, 0.52, 0.96],
  [0.61, 0.45, 0.8],
  [0.85, 0.4, 0.44],
];

/** The colours a provider's maximum effort wears: its brand. */
export type EffortBrand = "claude" | "antigravity" | "silver" | "purple";

type BrandPalette = {
  /** The effort name at maximum; also the near end of the fusion title. */
  title: Rgb;
  /** A gradient title (Gemini), when the brand has one. */
  titleGradient?: ReadonlyArray<Rgb>;
  /** The fill behind the particles: solid, or a left-to-right gradient. */
  fill: ReadonlyArray<Rgb>;
  /** The fill's darkest colour, for the fusion blend and the knob's glow. */
  fillColor: Rgb;
  /** Particles, sheen and arc cores: white on colour, dark on white. */
  spark: Rgb;
  /** A fill light enough that the knob and stops must read dark against it. */
  isLight: boolean;
};

const BRANDS: Record<EffortBrand, BrandPalette> = {
  claude: {
    title: [0.93, 0.58, 0.44],
    fill: [[0.8, 0.42, 0.28]],
    fillColor: [0.8, 0.42, 0.28],
    spark: WHITE,
    isLight: false,
  },
  antigravity: {
    title: [0.61, 0.45, 0.8],
    titleGradient: GEMINI,
    fill: GEMINI,
    fillColor: [0.56, 0.45, 0.8],
    spark: WHITE,
    isLight: false,
  },
  // Brands whose marks are black and white get a white fill with dark sparks.
  silver: {
    title: [0.92, 0.92, 0.94],
    fill: [WHITE, [0.88, 0.88, 0.91]],
    fillColor: [0.92, 0.92, 0.94],
    spark: BLACK,
    isLight: true,
  },
  purple: {
    title: [0.74, 0.55, 1],
    fill: [[0.55, 0.34, 0.97]],
    fillColor: [0.55, 0.34, 0.97],
    spark: WHITE,
    isLight: false,
  },
};

export function effortBrandForDriver(driver: ProviderDriverKind | null | undefined): EffortBrand {
  switch (driver) {
    case "claudeAgent":
      return "claude";
    case "antigravity":
      return "antigravity";
    case "codex":
    case "cursor":
    case "grok":
    case "opencode":
    case "commandCode":
      return "silver";
    default:
      return "purple";
  }
}

export type EffortTrackKind = "plain" | "supercharged" | "fast" | "fusion";

export function effortTrackKind(input: { peak: boolean; fast: boolean }): EffortTrackKind {
  if (input.peak) return input.fast ? "fusion" : "supercharged";
  return input.fast ? "fast" : "plain";
}

function cssGradient(colors: ReadonlyArray<Rgb>): string {
  return `linear-gradient(90deg, ${colors.map((color) => rgba(color)).join(", ")})`;
}

/** Everything the DOM layers need for one look: CSS colour strings. */
export type EffortTrackStyle = {
  /** The fill's CSS background for a non-plain look. */
  fillBackground: string;
  /** The title: a solid colour, or a gradient clipped to the text. */
  titleColor: string;
  titleGradient: string | null;
  /** The blurred disc under the knob. */
  glow: string;
  /** Stops the knob has passed. */
  stopPassed: string;
  /** The knob's white tint and its edge (only on light fills). */
  knobTint: string;
  knobEdge: string;
  /** The entry surge's glow colour. */
  surge: string;
};

export function effortTrackStyle(kind: EffortTrackKind, brand: EffortBrand): EffortTrackStyle {
  const palette = BRANDS[brand];
  const isLightFill = kind === "supercharged" && palette.isLight;
  const fill =
    kind === "supercharged"
      ? palette.fill
      : kind === "fast"
        ? [FAST_FILL]
        : [palette.fillColor, palette.fillColor, FAST_FILL];
  const title =
    kind === "fast"
      ? FAST_TITLE
      : brand === "silver" && kind === "supercharged"
        ? null
        : palette.title;
  return {
    fillBackground: fill.length === 1 ? rgba(fill[0]!) : cssGradient(fill),
    titleColor: title ? rgba(title) : "var(--foreground)",
    titleGradient:
      kind === "fusion"
        ? cssGradient([palette.title, FAST_TITLE])
        : kind === "supercharged" && palette.titleGradient
          ? cssGradient(palette.titleGradient)
          : null,
    glow:
      kind === "plain"
        ? rgba(BLACK, 0.28)
        : kind === "fast"
          ? rgba(FAST_FILL, 0.7)
          : kind === "fusion"
            ? rgba(FAST_TITLE, 0.75)
            : palette.isLight
              ? rgba(BLACK, 0.35)
              : rgba(palette.fillColor, 0.6),
    stopPassed: isLightFill ? rgba(BLACK, 0.35) : rgba(WHITE, 0.6),
    knobTint: rgba(WHITE, isLightFill ? 0.55 : 0.32),
    knobEdge: isLightFill ? rgba(BLACK, 0.14) : "transparent",
    surge: kind === "fusion" ? rgba(FAST_TITLE, 0.8) : rgba(palette.title, 0.8),
  };
}

// ---------------------------------------------------------------------------
// The live effect, drawn into a canvas clipped to the fill.
// ---------------------------------------------------------------------------

/** A stable pseudo-random value in [0, 1) for an element and one of its traits. */
export function effortRandom(index: number, trait: number): number {
  const value = Math.sin(index * 12.9898 + trait * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/** Fades a point out over the last 14px at either end of the fill. */
export function edgeFade(x: number, width: number): number {
  return Math.min(1, Math.max(0, x / 14), Math.max(0, (width - x) / 14));
}

/** Frames per second the effect needs: sparks alone are slow, streaks and bolts are not. */
export function effortTrackFrameRate(kind: EffortTrackKind): number {
  return kind === "supercharged" ? 30 : 60;
}

export type EffortTrackFrame = {
  kind: EffortTrackKind;
  brand: EffortBrand;
  /** Visible fill width and track height, in CSS pixels. */
  width: number;
  height: number;
  /** Seconds since the effect started. */
  time: number;
  /** The knob centre and the stop centres the knob has passed, in CSS pixels. */
  knobX: number;
  passedStopXs: ReadonlyArray<number>;
};

export function drawEffortTrackFrame(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame) {
  if (frame.width <= 8 || frame.kind === "plain") return;
  const palette = BRANDS[frame.brand];
  if (frame.kind === "supercharged" || frame.kind === "fusion") {
    drawParticles(ctx, frame, palette.spark);
  }
  if (frame.kind === "supercharged") {
    drawArcs(ctx, frame, palette);
  }
  if (frame.kind === "fast" || frame.kind === "fusion") {
    drawStreaks(ctx, frame);
  }
  if (frame.kind === "fusion") {
    drawBolts(ctx, frame);
    drawSheen(ctx, frame, palette.spark);
    drawFlare(ctx, frame);
  }
}

/** Sparks drifting through the fill toward the knob, each with its own height, size, speed and shimmer. */
function drawParticles(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame, color: Rgb) {
  const { width, height, time } = frame;
  const span = width + 8;
  const count = Math.max(10, Math.floor(width / 5));
  for (let index = 0; index < count; index += 1) {
    const seed = index;
    const lift = effortRandom(seed, 1);
    const speed = 12 + 28 * effortRandom(seed, 2);
    const radius = 0.7 + 1.1 * effortRandom(seed, 3);
    const start = effortRandom(seed, 4) * span;
    const brightness = 0.22 + 0.5 * effortRandom(seed, 5);
    const x = ((start + time * speed) % span) - 4;
    const y = height * (0.16 + 0.68 * lift);
    const shimmer = 0.6 + 0.4 * Math.sin(time * (2 + 3 * effortRandom(seed, 6)) + seed);
    const opacity = brightness * shimmer * edgeFade(x, width);
    if (opacity <= 0.01) continue;
    ctx.fillStyle = rgba(color, opacity);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Thin streaks racing toward the knob, bright at the head and fading down the tail. */
function drawStreaks(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame) {
  const { width, height, time } = frame;
  const count = Math.max(5, Math.floor(width / 14));
  for (let index = 0; index < count; index += 1) {
    const seed = index + 100;
    const length = 10 + 20 * effortRandom(seed, 1);
    const speed = 110 + 190 * effortRandom(seed, 2);
    const thickness = 1.1 + 1.1 * effortRandom(seed, 3);
    const span = width + length + 12;
    const x = ((effortRandom(seed, 4) * span + time * speed) % span) - length - 6;
    const y = height * (0.2 + 0.6 * effortRandom(seed, 5));
    const brightness = (0.35 + 0.55 * effortRandom(seed, 6)) * edgeFade(x + length, width);
    if (brightness <= 0.02) continue;
    const gradient = ctx.createLinearGradient(x, y, x + length, y);
    gradient.addColorStop(0, rgba(WHITE, 0));
    gradient.addColorStop(1, rgba(WHITE, brightness));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, y - thickness / 2, length, thickness, thickness / 2);
    ctx.fill();
  }
}

/** A flash on its own beat: which cycle it is in, and its intensity (0 when dark). */
export function flashAt(input: {
  seed: number;
  time: number;
  basePeriod: number;
  periodSpread: number;
  flash: number;
}): { cycle: number; intensity: number } {
  const period = input.basePeriod + input.periodSpread * effortRandom(input.seed, 1);
  const offset = effortRandom(input.seed, 2) * period;
  const cycle = Math.floor((input.time + offset) / period);
  const phase = input.time + offset - cycle * period;
  return {
    cycle,
    intensity: phase < input.flash ? Math.sin((phase / input.flash) * Math.PI) : 0,
  };
}

function strokeGlowing(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  glow: { color: string; width: number; blur: number },
  core: { color: string; width: number },
) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.save();
  ctx.shadowColor = glow.color;
  ctx.shadowBlur = glow.blur;
  ctx.strokeStyle = glow.color;
  ctx.lineWidth = glow.width;
  ctx.stroke(path);
  ctx.restore();
  ctx.strokeStyle = core.color;
  ctx.lineWidth = core.width;
  ctx.stroke(path);
}

/** Two big lightning bolts on their own beats, each a glowing zigzag the full height of the track. */
function drawBolts(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame) {
  const { width, height, time } = frame;
  for (let slot = 0; slot < 2; slot += 1) {
    const seed = slot + 200;
    const { cycle, intensity } = flashAt({
      seed,
      time,
      basePeriod: 1.4,
      periodSpread: 0.9,
      flash: 0.26,
    });
    if (intensity <= 0) continue;
    const cycleSeed = seed + cycle * 7.31;
    const x = 12 + (width - 24) * effortRandom(cycleSeed, 3);
    if (x <= 6 || x >= width - 6) continue;
    const lean = 3 + 3 * effortRandom(cycleSeed, 4);
    const bolt = new Path2D();
    bolt.moveTo(x + lean, 3);
    bolt.lineTo(x - lean * 0.4, height * 0.42);
    bolt.lineTo(x + lean * 0.5, height * 0.5);
    bolt.lineTo(x - lean, height - 3);
    strokeGlowing(
      ctx,
      bolt,
      { color: rgba(FAST_TITLE, 0.9 * intensity), width: 4, blur: 6 },
      { color: rgba(WHITE, intensity), width: 1.5 },
    );
  }
}

/**
 * Max effort's electricity: one small crackling arc at a time, jumping between
 * two neighbouring passed stops or up from the fill's edge, flashing for a
 * fifth of a second every one to two seconds.
 */
function drawArcs(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame, palette: BrandPalette) {
  const { width, height, time, passedStopXs } = frame;
  const seed = 300;
  const { cycle, intensity } = flashAt({ seed, time, basePeriod: 1, periodSpread: 1, flash: 0.2 });
  if (intensity <= 0) return;
  const cycleSeed = seed + cycle * 5.17;
  const segments = 3 + Math.floor(effortRandom(cycleSeed, 5) * 3);
  let from: [number, number];
  let to: [number, number];
  if (passedStopXs.length >= 2 && effortRandom(cycleSeed, 3) < 0.6) {
    const pair = Math.floor(effortRandom(cycleSeed, 4) * (passedStopXs.length - 1));
    from = [passedStopXs[pair]!, height / 2];
    to = [passedStopXs[pair + 1]!, height / 2];
  } else {
    const x = 12 + Math.max(width - 24, 0) * effortRandom(cycleSeed, 4);
    from = [x, height - 3];
    to = [x + (effortRandom(cycleSeed, 6) - 0.5) * 10, height * 0.22];
  }
  const arc = new Path2D();
  arc.moveTo(from[0], from[1]);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  // Jag each joint sideways, alternating, so the arc reads as a zigzag.
  const normal: [number, number] = [-dy / length, dx / length];
  for (let step = 1; step < segments; step += 1) {
    const along = step / segments;
    const jag = (2 + 2 * effortRandom(cycleSeed, 10 + step)) * (step % 2 === 0 ? 1 : -1);
    arc.lineTo(from[0] + dx * along + normal[0] * jag, from[1] + dy * along + normal[1] * jag);
  }
  arc.lineTo(to[0], to[1]);
  strokeGlowing(
    ctx,
    arc,
    {
      color: rgba(palette.isLight ? [0.55, 0.55, 0.6] : palette.title, 0.8 * intensity),
      width: 3,
      blur: 4,
    },
    { color: rgba(palette.spark, intensity), width: 1 },
  );
}

/** A slanted band of light sweeping the whole fill every few seconds. */
function drawSheen(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame, color: Rgb) {
  const { width, height, time } = frame;
  const band = 46;
  const period = 2.8;
  const progress = (time / period) % 1;
  const x = -band + (width + band * 2) * progress;
  const gradient = ctx.createLinearGradient(x, 0, x + band + 10, 0);
  gradient.addColorStop(0, rgba(color, 0));
  gradient.addColorStop(0.5, rgba(color, 0.22));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(x + 10, 0);
  ctx.lineTo(x + band + 10, 0);
  ctx.lineTo(x + band, height);
  ctx.lineTo(x, height);
  ctx.closePath();
  ctx.fill();
}

/** Fusion's flare at the knob: a white core fading to gold, pulsing gently. */
function drawFlare(ctx: CanvasRenderingContext2D, frame: EffortTrackFrame) {
  const radius = 35;
  const pulse = 0.35 + 0.15 * Math.sin(frame.time * 3);
  const y = frame.height / 2;
  const gradient = ctx.createRadialGradient(frame.knobX, y, 0, frame.knobX, y, radius);
  gradient.addColorStop(0, rgba(WHITE, pulse));
  gradient.addColorStop(0.35, rgba(FAST_TITLE, pulse * 0.6));
  gradient.addColorStop(1, rgba(FAST_FILL, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(frame.knobX - radius, y - radius, radius * 2, radius * 2);
}
