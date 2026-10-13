import { describe, expect, it } from "vite-plus/test";

import {
  countAgentGroups,
  countSidebarAttention,
  flattenChatRows,
  hasUnseenCompletion,
  resolveAgentStatusGroup,
  sortChatAgents,
  sortFolderChats,
  type AgentStatusGroup,
} from "./threadArrangement.ts";
import { buildSidebarThreadTree, selectThreadTreeSearchMatches } from "./threadTree.ts";

type TurnState = "running" | "completed" | "interrupted" | "error";

interface Shell {
  readonly id: string;
  readonly title: string;
  readonly parent: string | null;
  readonly createdAt: string;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: "running" | "ready" | "error" } | null;
  readonly latestTurn: {
    readonly state: TurnState;
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

const at = (minute: number) => `2026-10-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

function shell(
  id: string,
  overrides: Partial<Omit<Shell, "latestTurn">> & {
    readonly turn?: TurnState | null;
    readonly minute?: number;
  } = {},
): Shell {
  const minute = overrides.minute ?? 0;
  const turn = overrides.turn === undefined ? "completed" : overrides.turn;
  return {
    id,
    title: overrides.title ?? id,
    parent: overrides.parent ?? null,
    createdAt: at(0),
    latestUserMessageAt: overrides.latestUserMessageAt ?? null,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    session:
      overrides.session === undefined
        ? { status: turn === "running" ? "running" : "ready" }
        : overrides.session,
    latestTurn:
      turn === null
        ? null
        : {
            state: turn,
            requestedAt: at(minute),
            startedAt: at(minute),
            completedAt: turn === "running" ? null : at(minute + 1),
          },
  };
}

// The status a test sees in a shell: the same rule the sidebar uses.
const groupOf = (thread: Shell): AgentStatusGroup => resolveAgentStatusGroup(thread as never);

describe("resolveAgentStatusGroup", () => {
  it("puts questions and approvals ahead of running, and stopped work in done", () => {
    expect(groupOf(shell("a", { turn: "running" }))).toBe("working");
    expect(groupOf(shell("a", { turn: "running", hasPendingUserInput: true }))).toBe("needs-you");
    expect(groupOf(shell("a", { hasPendingApprovals: true }))).toBe("needs-you");
    expect(groupOf(shell("a", { turn: "error" }))).toBe("failed");
    expect(groupOf(shell("a", { session: { status: "error" } }))).toBe("failed");
    expect(groupOf(shell("a"))).toBe("done");
    expect(groupOf(shell("a", { turn: "interrupted" }))).toBe("done");
    // Spawned, first turn not started yet.
    expect(groupOf(shell("a", { turn: null }))).toBe("working");
  });
});

describe("sortChatAgents", () => {
  const agents = [
    shell("done-old", { minute: 1, title: "beta" }),
    shell("working-old", { turn: "running", minute: 2, title: "delta" }),
    shell("failed", { turn: "error", minute: 3, title: "alpha" }),
    shell("done-new", { minute: 9, title: "Alpha 10" }),
    shell("needs", { hasPendingUserInput: true, minute: 4, title: "gamma" }),
    shell("working-new", { turn: "running", minute: 8, title: "Alpha 2" }),
  ];

  it("groups by status, newest first inside each group", () => {
    expect(sortChatAgents(agents as never[], "status").map((agent: Shell) => agent.id)).toEqual([
      "working-new",
      "working-old",
      "needs",
      "failed",
      "done-new",
      "done-old",
    ]);
  });

  it("orders by latest activity or by name", () => {
    expect(sortChatAgents(agents as never[], "recent").map((agent: Shell) => agent.id)).toEqual([
      "done-new",
      "working-new",
      "needs",
      "failed",
      // Tied at 10:02 (one started, one finished): the id breaks the tie.
      "done-old",
      "working-old",
    ]);
    expect(sortChatAgents(agents as never[], "name").map((agent: Shell) => agent.title)).toEqual([
      "alpha",
      "Alpha 2",
      "Alpha 10",
      "beta",
      "delta",
      "gamma",
    ]);
  });

  it("does not reorder its input", () => {
    const before = agents.map((agent) => agent.id);
    sortChatAgents(agents as never[], "status");
    expect(agents.map((agent) => agent.id)).toEqual(before);
  });

  it("sorts chats by a user message newer than their last turn", () => {
    const chats = [
      shell("quiet", { minute: 5 }),
      shell("typed", { minute: 1, latestUserMessageAt: at(30) }),
    ];
    expect(sortFolderChats(chats as never[], "recent").map((chat: Shell) => chat.id)).toEqual([
      "typed",
      "quiet",
    ]);
  });
});

function chatTree(threads: readonly Shell[]) {
  const tree = buildSidebarThreadTree({
    projects: ["p"],
    threads,
    projectKeyOf: (project) => project,
    threadKeyOf: (thread) => thread.id,
    parentKeyOf: (thread) => thread.parent,
    folderKeyOf: () => "p",
    isPinned: () => false,
    sortPinned: (pinned) => pinned,
    sortRoots: (roots) => roots,
    sortChildren: (children) => sortChatAgents(children as never[], "status"),
  });
  return tree.folders[0]!.nodes[0]!;
}

function describeRows(rows: ReturnType<typeof flattenChatRows<Shell>>) {
  return rows.map((row) =>
    row.kind === "thread"
      ? `${"  ".repeat(row.row.depth)}${row.key}${row.row.isLastSibling && row.row.depth > 0 ? " (last)" : ""}`
      : row.kind === "group"
        ? `[${row.group} ${row.count}]`
        : `[done ${row.count} ${row.expanded ? "open" : "closed"}]`,
  );
}

describe("flattenChatRows", () => {
  const threads = [
    shell("lead", { turn: "running" }),
    shell("w1", { parent: "lead", turn: "running", minute: 3 }),
    shell("n1", { parent: "lead", hasPendingApprovals: true }),
    shell("d1", { parent: "lead", minute: 5 }),
    shell("d2", { parent: "lead", minute: 2 }),
    shell("w1-child", { parent: "w1", minute: 1 }),
  ];
  const root = chatTree(threads);

  it("labels each group and folds Done behind its count", () => {
    const rows = flattenChatRows(root, {
      isExpanded: () => true,
      groupOf,
      isDoneExpanded: () => false,
    });
    expect(describeRows(rows)).toEqual([
      "lead",
      "[working 1]",
      "  w1",
      "    w1-child (last)",
      "[needs-you 1]",
      "  n1 (last)",
      "[done 2 closed]",
    ]);
  });

  it("shows done agents once the group opens", () => {
    const rows = flattenChatRows(root, {
      isExpanded: () => true,
      groupOf,
      isDoneExpanded: (leadKey) => leadKey === "lead",
    });
    expect(describeRows(rows).slice(-3)).toEqual(["[done 2 open]", "  d1", "  d2 (last)"]);
  });

  it("skips labels and the fold when every agent shares one group", () => {
    const allDone = chatTree([shell("lead"), shell("d1", { parent: "lead" })]);
    const rows = flattenChatRows(allDone, {
      isExpanded: () => true,
      groupOf,
      isDoneExpanded: () => false,
    });
    expect(describeRows(rows)).toEqual(["lead", "  d1 (last)"]);
  });

  it("renders only the chat while it is folded, and a flat list without groups", () => {
    expect(
      describeRows(
        flattenChatRows(root, { isExpanded: () => false, groupOf, isDoneExpanded: () => false }),
      ),
    ).toEqual(["lead"]);
    expect(
      describeRows(
        flattenChatRows(root, {
          isExpanded: (key) => key === "lead",
          groupOf: null,
          isDoneExpanded: () => false,
        }),
      ),
    ).toEqual(["lead", "  w1", "  n1", "  d1", "  d2 (last)"]);
  });

  it("counts every agent below the chat by group", () => {
    expect(countAgentGroups(root, groupOf)).toEqual({
      working: 1,
      "needs-you": 1,
      failed: 0,
      done: 3,
    });
  });
});

describe("countSidebarAttention", () => {
  it("counts each thread once, the most urgent state winning", () => {
    const threads = [
      shell("asks", { turn: "running", hasPendingUserInput: true }),
      shell("runs", { turn: "running" }),
      shell("finished-unseen"),
      shell("finished-seen"),
      shell("failed", { turn: "error" }),
    ];
    const unseen = new Set(["finished-unseen"]);
    expect(
      countSidebarAttention(threads as never[], (thread: Shell) => unseen.has(thread.id)),
    ).toEqual({ "needs-you": 1, working: 1, new: 1 });
  });
});

describe("hasUnseenCompletion", () => {
  it("is true only for a turn that finished after the last visit", () => {
    const completed = { completedAt: at(10) };
    expect(hasUnseenCompletion({ latestTurn: completed, lastVisitedAt: at(5) })).toBe(true);
    expect(hasUnseenCompletion({ latestTurn: completed, lastVisitedAt: at(20) })).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: completed, lastVisitedAt: null })).toBe(false);
    expect(hasUnseenCompletion({ latestTurn: { completedAt: null }, lastVisitedAt: at(5) })).toBe(
      false,
    );
  });
});

describe("selectThreadTreeSearchMatches without descendants", () => {
  it("keeps a matching agent's path but not its siblings or children", () => {
    const threads = [
      shell("lead"),
      shell("match", { parent: "lead" }),
      shell("sibling", { parent: "lead" }),
      shell("below", { parent: "match" }),
    ];
    const selection = selectThreadTreeSearchMatches({
      threads,
      threadKeyOf: (thread) => thread.id,
      parentKeyOf: (thread) => thread.parent,
      matches: (thread) => thread.id === "match",
      includeDescendants: false,
    });
    expect([...selection.keys].sort()).toEqual(["lead", "match"]);
    expect([...selection.expandKeys]).toEqual(["lead"]);
  });
});
