import type { GitGraphLane } from "@t3tools/contracts";

/**
 * The commit graph drawn one row at a time: each row holds the pieces of every edge that crosses
 * it, in its own 0..ROW_HEIGHT box. A row that opens (grid rows 0fr → 1fr) then clips its own
 * slice of the graph instead of leaving a drawing that no longer lines up.
 */
export const ROW_HEIGHT = 28;
const MID = ROW_HEIGHT / 2;
export const LANE_X: Record<GitGraphLane, number> = { base: 7, head: 19, side: 31 };
export const GRAPH_WIDTH = 38;

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
const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
};

/**
 * Edges run from a commit down to its parents. A first parent keeps the child's lane until the
 * parent's row and bends there (a branch leaving its base); a merged-in parent bends right away
 * and runs down its own lane (a branch coming in).
 */
export function layoutGraph(
  nodes: ReadonlyArray<GraphNode>,
): ReadonlyArray<ReadonlyArray<GraphSegment>> {
  const rowOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (node.sha !== null && !rowOf.has(node.sha)) rowOf.set(node.sha, index);
  });
  const rows = nodes.map(() => new Map<string, GraphSegment>());
  const add = (row: number, segment: GraphSegment) => {
    rows[row]?.set(`${segment.d}|${segment.lane}|${segment.dashed}`, segment);
  };
  nodes.forEach((node, child) => {
    node.parents.forEach((parentSha, parentIndex) => {
      const parent = rowOf.get(parentSha);
      if (parent === undefined || parent <= child) return;
      const parentNode = nodes[parent];
      if (parentNode === undefined) return;
      const xc = LANE_X[node.lane];
      const xp = LANE_X[parentNode.lane];
      const bendAtChild = parentIndex > 0 || node.sha === null;
      const lane = parentIndex > 0 || node.sha === null ? parentNode.lane : node.lane;
      const style = { lane, dashed: node.pending === true, target: node.sha === null };
      const runX = bendAtChild ? xp : xc;
      if (xc === xp) add(child, { d: line(xc, MID, ROW_HEIGHT), ...style });
      else if (bendAtChild) add(child, { d: curve(xc, MID, xp, ROW_HEIGHT), ...style });
      else add(child, { d: line(xc, MID, ROW_HEIGHT), ...style });
      for (let row = child + 1; row < parent; row += 1) {
        add(row, { d: line(runX, 0, ROW_HEIGHT), ...style });
      }
      if (xc === xp || bendAtChild) add(parent, { d: line(xp, 0, MID), ...style });
      else add(parent, { d: curve(xc, 0, xp, MID), ...style });
    });
  });
  return rows.map((segments) => [...segments.values()]);
}
