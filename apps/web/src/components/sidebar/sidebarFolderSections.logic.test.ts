import { describe, expect, it } from "vite-plus/test";

import {
  collectSidebarTreeThreads,
  filterSidebarFolderSections,
  isSidebarThreadPinnedOnTop,
  isSidebarThreadSettled,
  partitionSidebarFolderNodes,
} from "./sidebarFolderSections.logic";
import { buildSidebarThreadTree, type SidebarThreadTreeNode } from "./sidebarThreadTree";

interface TestThread {
  readonly id: string;
  readonly parent?: string;
  readonly settled?: boolean;
  readonly pinned?: boolean;
  readonly live?: boolean;
  /** Waiting on the user; such a thread is live too, as in the sidebar. */
  readonly needsUser?: boolean;
  readonly settledAt?: number;
  readonly order: number;
}

const byOrder = (threads: readonly TestThread[]) =>
  threads.toSorted((left, right) => left.order - right.order);

const isSettled = (thread: TestThread) => thread.settled === true;
const needsUser = (thread: TestThread) => thread.needsUser === true;
const isLive = (thread: TestThread) => thread.live === true || needsUser(thread);

function sections(threads: readonly TestThread[]) {
  const tree = buildSidebarThreadTree({
    projects: ["a"],
    threads,
    projectKeyOf: (project) => project,
    threadKeyOf: (thread) => thread.id,
    parentKeyOf: (thread) => thread.parent ?? null,
    folderKeyOf: () => "a",
    isPinned: (thread) =>
      isSidebarThreadPinnedOnTop(
        { pinnedAt: thread.pinned ? "2026-01-01T00:00:00.000Z" : null },
        isSettled(thread),
      ),
    sortPinned: byOrder,
    sortRoots: byOrder,
    sortChildren: byOrder,
    isWorking: isLive,
  });
  return {
    tree,
    ...partitionSidebarFolderNodes(tree.folders[0]!.nodes, {
      isSettled,
      isLive,
      needsUser,
      settledAtMs: (thread) => thread.settledAt ?? 0,
    }),
  };
}

function shape(nodes: readonly SidebarThreadTreeNode<TestThread>[]): unknown[] {
  return nodes.map((node) =>
    node.children.length === 0 ? node.key : { [node.key]: shape(node.children) },
  );
}

describe("isSidebarThreadSettled", () => {
  it("follows the server's settledOverride only where settlement is supported", () => {
    expect(isSidebarThreadSettled({ settledOverride: "settled" }, true)).toBe(true);
    expect(isSidebarThreadSettled({ settledOverride: "active" }, true)).toBe(false);
    expect(isSidebarThreadSettled({ settledOverride: null }, true)).toBe(false);
    expect(isSidebarThreadSettled({ settledOverride: "settled" }, false)).toBe(false);
  });
});

describe("partitionSidebarFolderNodes", () => {
  it("moves settled leads to the Settled group, newest settlement first", () => {
    const result = sections([
      { id: "active", order: 1 },
      { id: "old", order: 2, settled: true, settledAt: 10 },
      { id: "new", order: 3, settled: true, settledAt: 20 },
    ]);
    expect(shape(result.active)).toEqual(["active"]);
    expect(shape(result.settled)).toEqual(["new", "old"]);
  });

  it("keeps a lead and its child agents together, decided by the lead", () => {
    const settledLead = sections([
      { id: "lead", order: 1, settled: true },
      { id: "child", parent: "lead", order: 2 },
    ]);
    expect(shape(settledLead.settled)).toEqual([{ lead: ["child"] }]);
    expect(settledLead.active).toEqual([]);

    const activeLead = sections([
      { id: "lead", order: 1 },
      { id: "child", parent: "lead", order: 2, settled: true },
    ]);
    expect(shape(activeLead.active)).toEqual([{ lead: ["child"] }]);
    expect(activeLead.settled).toEqual([]);
  });

  it("brings a tree back to active when any thread in it is live again", () => {
    const leadRunning = sections([{ id: "lead", order: 1, settled: true, live: true }]);
    expect(shape(leadRunning.active)).toEqual(["lead"]);

    const childRunning = sections([
      { id: "lead", order: 1, settled: true },
      { id: "child", parent: "lead", order: 2, live: true },
    ]);
    expect(shape(childRunning.active)).toEqual([{ lead: ["child"] }]);
    expect(childRunning.settled).toEqual([]);
  });

  it("reclassifies on the next render once the server un-settles", () => {
    const before = sections([{ id: "t", order: 1, settled: true }]);
    expect(shape(before.settled)).toEqual(["t"]);
    const after = sections([{ id: "t", order: 1, settled: false }]);
    expect(shape(after.active)).toEqual(["t"]);
    expect(after.settled).toEqual([]);
  });

  it("keeps pinned threads on top unless they are settled", () => {
    const result = sections([
      { id: "pinned", order: 1, pinned: true },
      { id: "pinned-settled", order: 2, pinned: true, settled: true },
    ]);
    expect(shape(result.tree.pinned)).toEqual(["pinned"]);
    expect(shape(result.settled)).toEqual(["pinned-settled"]);
    expect(result.active).toEqual([]);
  });
});

describe("Needs you group", () => {
  it("collects trees whose lead waits on the user, keeping their order", () => {
    const result = sections([
      { id: "first", order: 1, needsUser: true },
      { id: "working", order: 2, live: true },
      { id: "second", order: 3, needsUser: true },
      { id: "idle", order: 4 },
    ]);
    expect(shape(result.needsYou)).toEqual(["first", "second"]);
    expect(shape(result.active)).toEqual(["working", "idle"]);
    expect(result.settled).toEqual([]);
  });

  it("pulls a whole tree up when one of its child agents waits on the user", () => {
    const result = sections([
      { id: "lead", order: 1 },
      { id: "child", parent: "lead", order: 2 },
      { id: "grandchild", parent: "child", order: 3, needsUser: true },
      { id: "other", order: 4 },
    ]);
    expect(shape(result.needsYou)).toEqual([{ lead: [{ child: ["grandchild"] }] }]);
    expect(shape(result.active)).toEqual(["other"]);
  });

  it("takes a settled lead whose child waits, and returns it once nothing waits", () => {
    const waiting = sections([
      { id: "lead", order: 1, settled: true },
      { id: "child", parent: "lead", order: 2, needsUser: true },
    ]);
    expect(shape(waiting.needsYou)).toEqual([{ lead: ["child"] }]);
    expect(waiting.settled).toEqual([]);

    const answered = sections([
      { id: "lead", order: 1, settled: true },
      { id: "child", parent: "lead", order: 2 },
    ]);
    expect(answered.needsYou).toEqual([]);
    expect(shape(answered.settled)).toEqual([{ lead: ["child"] }]);
  });

  it("leaves a pinned thread in the pinned list", () => {
    const result = sections([{ id: "pinned", order: 1, pinned: true, needsUser: true }]);
    expect(shape(result.tree.pinned)).toEqual(["pinned"]);
    expect(result.needsYou).toEqual([]);
  });
});

describe("filterSidebarFolderSections", () => {
  const threads: TestThread[] = [
    { id: "alpha", order: 1 },
    { id: "beta", order: 2 },
    { id: "gamma-lead", order: 3, settled: true },
    { id: "gamma-child", parent: "gamma-lead", order: 4 },
    { id: "delta-child", parent: "beta", order: 5, live: true },
    { id: "epsilon-lead", order: 6 },
    { id: "epsilon-child", parent: "epsilon-lead", order: 7, needsUser: true },
  ];

  const search = (query: string) => {
    const { needsYou, active, settled } = sections(threads);
    return filterSidebarFolderSections(
      { needsYou, active, settled },
      { matches: (key) => key.includes(query), isWorking: isLive },
    );
  };

  it("matches active threads without opening Settled", () => {
    const result = search("alpha");
    expect(result.needsYou).toEqual([]);
    expect(shape(result.active)).toEqual(["alpha"]);
    expect(result.settled).toEqual([]);
    expect(result.settledHasMatch).toBe(false);
  });

  it("reports that Settled must open when a settled child agent matches", () => {
    const result = search("gamma-child");
    expect(result.active).toEqual([]);
    expect(shape(result.settled)).toEqual([{ "gamma-lead": ["gamma-child"] }]);
    expect(result.settledHasMatch).toBe(true);
  });

  it("keeps the lead as the path to a matching child and recounts it", () => {
    const result = search("delta");
    expect(shape(result.active)).toEqual([{ beta: ["delta-child"] }]);
    expect(result.active[0]!.descendantCount).toBe(1);
    expect(result.active[0]!.workingDescendantCount).toBe(1);
  });

  it("keeps a matching lead's whole tree", () => {
    const result = search("gamma-lead");
    expect(shape(result.settled)).toEqual([{ "gamma-lead": ["gamma-child"] }]);
  });

  it("keeps matches inside the Needs you group", () => {
    const result = search("epsilon-child");
    expect(shape(result.needsYou)).toEqual([{ "epsilon-lead": ["epsilon-child"] }]);
    expect(result.active).toEqual([]);
    expect(result.settledHasMatch).toBe(false);
  });

  it("returns nothing when no thread matches", () => {
    const result = search("zzz");
    expect(result.needsYou).toEqual([]);
    expect(result.active).toEqual([]);
    expect(result.settled).toEqual([]);
    expect(result.settledHasMatch).toBe(false);
  });
});

describe("collectSidebarTreeThreads", () => {
  it("lists every thread including child agents, active and settled", () => {
    const { active, settled } = sections(threads());
    expect(collectSidebarTreeThreads([...active, ...settled]).map((thread) => thread.id)).toEqual([
      "a",
      "a-child",
      "s",
    ]);
  });

  function threads(): TestThread[] {
    return [
      { id: "a", order: 1 },
      { id: "a-child", parent: "a", order: 2 },
      { id: "s", order: 3, settled: true },
    ];
  }
});
