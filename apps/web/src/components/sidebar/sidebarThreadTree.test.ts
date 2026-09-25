import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarThreadTree,
  collectVisibleSidebarThreadKeys,
  flattenSidebarThreadNode,
  sidebarThreadAncestorKeys,
  type SidebarThreadTreeNode,
} from "./sidebarThreadTree";

interface TestThread {
  readonly id: string;
  readonly project: string;
  readonly parent?: string;
  readonly pinned?: boolean;
  readonly order: number;
}

const byOrder = (threads: readonly TestThread[]) =>
  threads.toSorted((left, right) => left.order - right.order);

function build(threads: readonly TestThread[], projects: readonly string[] = ["a", "b"]) {
  return buildSidebarThreadTree({
    projects,
    threads,
    projectKeyOf: (project) => project,
    threadKeyOf: (thread) => thread.id,
    parentKeyOf: (thread) => thread.parent ?? null,
    folderKeyOf: (thread) => thread.project,
    isPinned: (thread) => thread.pinned === true,
    sortPinned: byOrder,
    sortRoots: byOrder,
    sortChildren: byOrder,
  });
}

function shape(nodes: readonly SidebarThreadTreeNode<TestThread>[]): unknown[] {
  return nodes.map((node) =>
    node.children.length === 0 ? node.key : { [node.key]: shape(node.children) },
  );
}

describe("buildSidebarThreadTree", () => {
  it("groups top-level threads into project folders in project order", () => {
    const tree = build([
      { id: "b1", project: "b", order: 1 },
      { id: "a2", project: "a", order: 2 },
      { id: "a1", project: "a", order: 1 },
    ]);
    expect(tree.folders.map((folder) => [folder.key, shape(folder.nodes)])).toEqual([
      ["a", ["a1", "a2"]],
      ["b", ["b1"]],
    ]);
  });

  it("keeps empty projects as folders", () => {
    const tree = build([], ["a"]);
    expect(tree.folders).toEqual([{ key: "a", project: "a", nodes: [] }]);
  });

  it("nests child agents under their parent recursively and counts descendants", () => {
    const tree = build([
      { id: "root", project: "a", order: 1 },
      { id: "child2", project: "a", parent: "root", order: 3 },
      { id: "child1", project: "a", parent: "root", order: 2 },
      { id: "grandchild", project: "a", parent: "child1", order: 4 },
    ]);
    expect(shape(tree.folders[0]!.nodes)).toEqual([
      { root: [{ child1: ["grandchild"] }, "child2"] },
    ]);
    expect(tree.folders[0]!.nodes[0]!.descendantCount).toBe(3);
    expect(tree.parentKeyByKey.get("grandchild")).toBe("child1");
    expect(tree.folderKeyByThreadKey.get("grandchild")).toBe("a");
    expect(sidebarThreadAncestorKeys(tree, "grandchild")).toEqual(["child1", "root"]);
  });

  it("promotes a child whose parent is missing (archived or deleted) to top level", () => {
    const tree = build([
      { id: "orphan", project: "a", parent: "archived-parent", order: 1 },
      { id: "other", project: "a", order: 2 },
    ]);
    expect(shape(tree.folders[0]!.nodes)).toEqual(["orphan", "other"]);
    expect(tree.parentKeyByKey.has("orphan")).toBe(false);
  });

  it("breaks parent cycles without losing any thread", () => {
    const tree = build([
      { id: "x", project: "a", parent: "y", order: 1 },
      { id: "y", project: "a", parent: "x", order: 2 },
      { id: "self", project: "a", parent: "self", order: 3 },
      { id: "z", project: "a", parent: "x", order: 4 },
    ]);
    expect(shape(tree.folders[0]!.nodes)).toEqual([{ x: ["z"] }, "y", "self"]);
  });

  it("lifts pinned top-level threads out of their folder, children and all", () => {
    const tree = build([
      { id: "p2", project: "b", pinned: true, order: 2 },
      { id: "p1", project: "a", pinned: true, order: 1 },
      { id: "p1-child", project: "a", parent: "p1", order: 3 },
      { id: "a1", project: "a", order: 4 },
    ]);
    expect(shape(tree.pinned)).toEqual([{ p1: ["p1-child"] }, "p2"]);
    expect(shape(tree.folders[0]!.nodes)).toEqual(["a1"]);
    expect(tree.folderKeyByThreadKey.has("p1-child")).toBe(false);
  });

  it("keeps a pinned child agent under its parent", () => {
    const tree = build([
      { id: "root", project: "a", order: 1 },
      { id: "child", project: "a", parent: "root", pinned: true, order: 2 },
    ]);
    expect(tree.pinned).toEqual([]);
    expect(shape(tree.folders[0]!.nodes)).toEqual([{ root: ["child"] }]);
  });

  it("nests under the parent even when the child lives in another project", () => {
    const tree = build([
      { id: "root", project: "a", order: 1 },
      { id: "child", project: "b", parent: "root", order: 2 },
    ]);
    expect(shape(tree.folders[0]!.nodes)).toEqual([{ root: ["child"] }]);
    expect(tree.folders[1]!.nodes).toEqual([]);
  });

  it("drops unpinned top-level threads whose project has no folder", () => {
    const tree = build([
      { id: "stray", project: "gone", order: 1 },
      { id: "stray-pinned", project: "gone", pinned: true, order: 2 },
    ]);
    expect(tree.folders.every((folder) => folder.nodes.length === 0)).toBe(true);
    expect(shape(tree.pinned)).toEqual(["stray-pinned"]);
  });
});

describe("flattenSidebarThreadNode", () => {
  const tree = build([
    { id: "root", project: "a", order: 1 },
    { id: "c1", project: "a", parent: "root", order: 2 },
    { id: "c1a", project: "a", parent: "c1", order: 3 },
    { id: "c2", project: "a", parent: "root", order: 4 },
    { id: "c2a", project: "a", parent: "c2", order: 5 },
  ]);
  const root = tree.folders[0]!.nodes[0]!;

  it("emits depth, last-sibling and continuing-guide flags in render order", () => {
    const rows = flattenSidebarThreadNode(root, () => true).map((row) => [
      row.node.key,
      row.depth,
      row.isLastSibling,
      row.guides,
    ]);
    expect(rows).toEqual([
      ["root", 0, true, []],
      ["c1", 1, false, []],
      // c1 has a later sibling, so the depth-1 connector runs past c1a.
      ["c1a", 2, true, [true]],
      ["c2", 1, true, []],
      ["c2a", 2, true, [false]],
    ]);
  });

  it("hides the subtree of a collapsed thread", () => {
    const rows = flattenSidebarThreadNode(root, (key) => key !== "c1");
    expect(rows.map((row) => row.node.key)).toEqual(["root", "c1", "c2", "c2a"]);
  });
});

describe("collectVisibleSidebarThreadKeys", () => {
  it("lists pinned rows first, then expanded folders, skipping collapsed ones", () => {
    const tree = build([
      { id: "pin", project: "b", pinned: true, order: 1 },
      { id: "a1", project: "a", order: 2 },
      { id: "a1-child", project: "a", parent: "a1", order: 3 },
      { id: "b1", project: "b", order: 4 },
    ]);
    expect(
      collectVisibleSidebarThreadKeys(
        tree,
        (folderKey) => folderKey !== "b",
        () => true,
      ),
    ).toEqual(["pin", "a1", "a1-child"]);
    expect(
      collectVisibleSidebarThreadKeys(
        tree,
        () => true,
        (threadKey) => threadKey !== "a1",
      ),
    ).toEqual(["pin", "a1", "b1"]);
  });
});
