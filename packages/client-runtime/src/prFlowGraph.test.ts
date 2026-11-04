import { describe, expect, it } from "vite-plus/test";

import { type PrFlow, prFlowCreating } from "./prFlow.ts";
import { layoutPrFlowGraph } from "./prFlowGraph.ts";

const commit = (sha: string, lane: "head" | "base", parents: ReadonlyArray<string>) => ({
  kind: "commit" as const,
  key: sha,
  sha,
  subject: sha,
  author: "You",
  authoredAt: "2026-10-26T12:00:00Z",
  lane,
  refs: [],
  parents,
  conflicts: 0,
  resolved: false,
});

const flow = (phase: PrFlow["phase"]): PrFlow => ({
  ...prFlowCreating({ title: "t", head: "feat", stepLabel: null, commitsToPush: null }),
  phase,
  number: 128,
  base: "main",
  rows: [
    commit("tip", "head", ["fork"]),
    commit("main", "base", ["fork"]),
    commit("fork", "base", []),
  ],
  conflicts: phase === "conflicts" ? { unit: "conflict", total: 3, resolved: 0, files: [] } : null,
});

describe("layoutPrFlowGraph", () => {
  it("draws the merge into the base once there is a pull request to merge", () => {
    expect(layoutPrFlowGraph(flow("pushing")).showTarget).toBe(false);
    const open = layoutPrFlowGraph(flow("ready"));
    expect(open.showTarget).toBe(true);
    expect(open.rowOffset).toBe(1);
  });

  it("turns only the branch's way into the base amber while conflicts stand", () => {
    const { segments, edgeTone } = layoutPrFlowGraph(flow("conflicts"));
    const target = (segments[0] ?? []).filter((segment) => segment.target);
    expect(target.map(edgeTone).toSorted()).toEqual(["base", "warning"]);
  });

  it("turns the branch purple once merged", () => {
    const { segments, edgeTone } = layoutPrFlowGraph(flow("merged"));
    const head = segments.flat().filter((segment) => segment.lane === "head");
    expect(new Set(head.map(edgeTone))).toEqual(new Set(["merged"]));
  });
});
