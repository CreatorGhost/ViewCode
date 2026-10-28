import type { GitGraphLane } from "@t3tools/contracts";

import { type PrFlow, type PrFlowRow, prFlowReached, prFlowStatus } from "./prFlow.ts";

/**
 * The commit graph drawn one row at a time: each row holds the pieces of every edge that crosses
 * it, in its own 0..ROW_HEIGHT box. A row that opens (grid rows 0fr → 1fr on web) then clips its
 * own slice of the graph instead of leaving a drawing that no longer lines up. Web and the phone
 * draw the same layout.
 */
export const ROW_HEIGHT = 28;
const MID = ROW_HEIGHT / 2;
export const LANE_X: Record<GitGraphLane, number> = { base: 7, head: 17, side: 27 };
export const GRAPH_WIDTH = 34;

export interface GraphNode {
  readonly key: string;
  /** What parents name; the target row has none. */
  readonly sha: string | null;
  readonly lane: GitGraphLane;
  readonly parents: ReadonlyArray<string>;
  /** Edges to these parents are drawn dashed: the merge that has not happened yet. */
  readonly pending?: boolean;
}

export interface GraphSegment {
  readonly d: string;
  /** The lane whose colour the edge takes. */
  readonly lane: GitGraphLane;
  readonly dashed: boolean;
  /** Drawn from the target row: the pull request's own merge. */
  readonly target: boolean;
}

const line = (x: number, from: number, to: number) => `M${x} ${from}V${to}`;

/**
 * A lane change is one S-curve from the middle of one row to the middle of the next, vertical at
 * both ends. Each row draws its half: the cubic split at t = 1/2, which meets the row boundary
 * halfway between the two lanes.
 */
const bendTop = (from: number, to: number) =>
  `M${from} ${MID}C${from} ${MID + ROW_HEIGHT / 4} ${(3 * from + to) / 4} ${MID + (3 * ROW_HEIGHT) / 8} ${(from + to) / 2} ${ROW_HEIGHT}`;
const bendBottom = (from: number, to: number) =>
  `M${(from + to) / 2} 0C${(from + 3 * to) / 4} ${ROW_HEIGHT / 8} ${to} ${ROW_HEIGHT / 4} ${to} ${MID}`;

/**
 * Edges run from a commit down to its parents. A first parent keeps the child's lane and bends
 * into the parent's lane over the row above the parent (a branch leaving its base); a merged-in
 * parent bends right below the child and runs down its own lane (a branch coming in).
 */
export function layoutGraph(
  nodes: ReadonlyArray<GraphNode>,
): ReadonlyArray<ReadonlyArray<GraphSegment>> {
  const rowOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.sha !== null && !rowOf.has(node.sha)) rowOf.set(node.sha, index);
  });
  const rows = nodes.map(() => new Map<string, GraphSegment>());
  const add = (row: number, d: string, style: Omit<GraphSegment, "d">) => {
    rows[row]?.set(`${d}|${style.lane}|${style.dashed}`, { d, ...style });
  };
  nodes.forEach((node, child) => {
    node.parents.forEach((parentSha, parentIndex) => {
      const parent = rowOf.get(parentSha);
      if (parent === undefined || parent <= child) return;
      const parentNode = nodes[parent];
      if (parentNode === undefined) return;
      const xc = LANE_X[node.lane];
      const xp = LANE_X[parentNode.lane];
      const incoming = parentIndex > 0 || node.sha === null;
      const style = {
        lane: incoming ? parentNode.lane : node.lane,
        dashed: node.pending === true,
        target: node.sha === null,
      };
      if (xc === xp) {
        add(child, line(xc, MID, ROW_HEIGHT), style);
        for (let row = child + 1; row < parent; row += 1) add(row, line(xc, 0, ROW_HEIGHT), style);
        add(parent, line(xp, 0, MID), style);
        return;
      }
      // The bend runs from the middle of `bend` to the middle of `bend + 1`.
      const bend = incoming ? child : parent - 1;
      for (let row = child; row <= parent; row += 1) {
        const x = row <= bend ? xc : xp;
        if (row === bend) {
          if (row > child) add(row, line(x, 0, MID), style);
          add(row, bendTop(xc, xp), style);
        } else if (row === bend + 1) {
          add(row, bendBottom(xc, xp), style);
          if (row < parent) add(row, line(xp, MID, ROW_HEIGHT), style);
        } else if (row === child) {
          add(row, line(x, MID, ROW_HEIGHT), style);
        } else if (row === parent) {
          add(row, line(x, 0, MID), style);
        } else {
          add(row, line(x, 0, ROW_HEIGHT), style);
        }
      }
    });
  });
  return rows.map((segments) => [...segments.values()]);
}

/** How an edge is coloured: its lane's colour, or the pull request's merge in amber or purple. */
export type PrFlowEdgeTone = GitGraphLane | "warning" | "merged";

/**
 * The PR card's graph: the merge into the base on top (once there is a pull request to merge),
 * then the flow's rows, each with the edges that cross it and the tone of every edge.
 */
export function layoutPrFlowGraph(flow: PrFlow) {
  const showTarget = prFlowReached(flow.phase, "opening");
  const merged = flow.phase === "merged";
  const conflictPhase = flow.phase === "conflicts" || flow.phase === "resolving";
  const headTip = flow.rows.find((row) => row.kind !== "commit" || row.lane === "head");
  const baseTip = flow.rows.find((row) => row.kind === "commit" && row.lane === "base");
  const nodeSha = (row: PrFlowRow) => (row.kind === "commit" ? row.sha : row.kind);
  const nodes: ReadonlyArray<GraphNode> = [
    ...(showTarget
      ? [
          {
            key: "target",
            sha: null,
            lane: "base",
            parents: [headTip, baseTip].flatMap((row) => (row === undefined ? [] : [nodeSha(row)])),
            pending: !merged,
          } satisfies GraphNode,
        ]
      : []),
    ...flow.rows.map((row): GraphNode => ({
      key: row.key,
      sha: nodeSha(row),
      lane: row.kind === "commit" ? row.lane : "head",
      parents: row.parents,
      pending: row.kind !== "commit",
    })),
  ];
  const targetTone: PrFlowEdgeTone | undefined = merged
    ? "merged"
    : conflictPhase && prFlowStatus(flow).tone !== "busy"
      ? "warning"
      : undefined;
  // While conflicts stand, only the branch's way into the base turns amber; the base lane stays
  // its quiet grey, so the eye goes from the warning node to the commits that clash.
  const edgeTone = (segment: GraphSegment): PrFlowEdgeTone =>
    segment.target && targetTone !== undefined && (merged || segment.lane !== "base")
      ? targetTone
      : merged && segment.lane === "head"
        ? "merged"
        : segment.lane;
  return {
    showTarget,
    /** Rows of `flow.rows` start this far into `segments`. */
    rowOffset: showTarget ? 1 : 0,
    segments: layoutGraph(nodes),
    edgeTone,
  } as const;
}
