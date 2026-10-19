/**
 * Which ends of the rail a row draws. Work log rows are separate virtualized timeline items, so
 * each row draws its own stretch of the rail and the stretches meet at the item edges.
 */
export interface WorkLogRailEnds {
  readonly above: boolean;
  readonly below: boolean;
}

export type WorkLogLane = "main" | "branch" | "branch-start";

// The icon slot is 24px wide after the row's 2px inset, so the main rail runs at 14px and a
// branch lane 12px to its right, still clear of the label.
export const RAIL_X = 13.5;
export const BRANCH_OFFSET = 12;

/**
 * One stretch of rail, in px from the row's top-left. `height: null` runs to the row's bottom, so
 * the rail follows a row that grows (chips, expanded output) without measuring it.
 */
export interface WorkLogRailSegment {
  readonly part: "above" | "below" | "main";
  readonly shape: "line" | "curve";
  readonly left: number;
  readonly top: number;
  readonly height: number | null;
}

/**
 * The rail around one row's marker. On the main lane it stops `clearance` short of the marker on
 * both sides; on a branch the main rail passes straight by and the branch lane comes in from
 * above, curving off the main rail where the branch starts.
 */
export function workLogRailSegments(input: {
  readonly ends: WorkLogRailEnds;
  readonly markerY: number;
  readonly clearance: number;
  readonly lane: WorkLogLane;
}): WorkLogRailSegment[] {
  const { ends, markerY, clearance, lane } = input;
  const segments: WorkLogRailSegment[] = [];
  const toMarker = Math.max(0, markerY - clearance);
  if (lane === "main") {
    if (ends.above) {
      segments.push({ part: "above", shape: "line", left: RAIL_X, top: 0, height: toMarker });
    }
    if (ends.below) {
      segments.push({
        part: "below",
        shape: "line",
        left: RAIL_X,
        top: markerY + clearance,
        height: null,
      });
    }
    return segments;
  }
  if (ends.above || ends.below) {
    segments.push({
      part: "main",
      shape: "line",
      left: RAIL_X,
      top: ends.above ? 0 : markerY,
      height: ends.below ? null : markerY,
    });
  }
  segments.push(
    lane === "branch-start"
      ? { part: "above", shape: "curve", left: RAIL_X, top: 0, height: toMarker }
      : { part: "above", shape: "line", left: RAIL_X + BRANCH_OFFSET, top: 0, height: toMarker },
  );
  return segments;
}

export interface ChipArrivals {
  readonly keys: string;
  /** Chips that arrived while their step was live, in arrival order; they stagger in. */
  readonly fresh: ReadonlyArray<string>;
}

export function initialChipArrivals(keys: ReadonlyArray<string>, live: boolean): ChipArrivals {
  return { keys: keys.join("\n"), fresh: live ? keys : [] };
}

/** New chips stagger in only while the step is live; finished steps' chips mount still. */
export function advanceChipArrivals(
  state: ChipArrivals,
  keys: ReadonlyArray<string>,
  live: boolean,
): ChipArrivals {
  const joined = keys.join("\n");
  if (joined === state.keys) return state;
  const previous = new Set(state.keys.split("\n"));
  return { keys: joined, fresh: live ? keys.filter((key) => !previous.has(key)) : [] };
}
