import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { WorkLogPresentationEntry } from "./presentation.ts";
import {
  searchOutputFilePaths,
  webChipLabel,
  workLogChips,
  workLogChipSetsEqual,
  workLogEntryMarker,
  workLogHeaderLabel,
  workLogLabelTone,
  workLogMarker,
  workLogMarkerLane,
} from "./thinkingLog.ts";

const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread"),
  runId: null,
  attemptId: null,
  nodeId: null,
  providerTurnId: null,
  status: "completed",
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-19T10:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-10-19T10:00:01Z"),
  createdAt: DateTime.makeUnsafe("2026-10-19T10:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-19T10:00:01Z"),
} as const;

function item(fields: Record<string, unknown>): OrchestrationV2TurnItem {
  return { ...base, ...fields } as unknown as OrchestrationV2TurnItem;
}

function entry(
  id: string,
  fields: Partial<WorkLogPresentationEntry> = {},
): WorkLogPresentationEntry {
  return { id, createdAt: "2026-10-19T10:00:00Z", label: id, tone: "tool", ...fields };
}

const read = (id: string, path: string) =>
  entry(id, { requestKind: "file-read", changedFiles: [path] });

const command = (id: string, exitCode: number) =>
  entry(id, {
    itemType: "command_execution",
    command: "bun test",
    structuredPayload: item({ type: "command_execution", input: "bun test", exitCode }),
    toolLifecycleStatus: exitCode === 0 ? "completed" : "failed",
  });

describe("workLogMarker", () => {
  it("marks the live step with the spinner before anything else", () => {
    expect(workLogMarker({ live: true, failed: true, kind: "code-search" })).toBe("live");
  });

  it("marks failures as dead ends on the branch lane, dimmed", () => {
    const marker = workLogEntryMarker(command("fail", 1));
    expect(marker).toBe("dead-end");
    expect(workLogMarkerLane(marker)).toBe("branch");
    expect(workLogLabelTone(marker)).toBe("dim");
  });

  it("gives searches the magnifier and every other finished step a dot", () => {
    expect(workLogMarker({ kind: "code-search" })).toBe("search");
    expect(workLogMarker({ kind: "search" })).toBe("search");
    expect(workLogEntryMarker(command("ok", 0))).toBe("dot");
    expect(workLogEntryMarker(read("r", "src/a.ts"))).toBe("dot");
    expect(workLogLabelTone("dot")).toBe("done");
    expect(workLogLabelTone("live")).toBe("active");
    expect(workLogMarkerLane("dot")).toBe("main");
  });
});

describe("workLogChips", () => {
  it("lists read files once each, by basename, and folds the rest into +N more", () => {
    const set = workLogChips([
      read("1", "src/router.ts"),
      read("2", "src/auth.ts"),
      read("3", "src/router.ts"),
      read("4", "src/Button.tsx"),
      read("5", "src/session.ts"),
      read("6", "src/routes/index.ts"),
      read("7", "README.md"),
    ]);
    expect(set.chips.map((chip) => (chip.kind === "file" ? chip.name : chip.label))).toEqual([
      "router.ts",
      "auth.ts",
      "Button.tsx",
      "session.ts",
    ]);
    expect(set.chips[0]).toMatchObject({ kind: "file", path: "src/router.ts" });
    expect(set.moreCount).toBe(2);
  });

  it("lists the files an edit changed", () => {
    const set = workLogChips([
      entry("edit", {
        itemType: "file_change",
        structuredPayload: item({ type: "file_change", fileName: "apps/web/src/index.css" }),
      }),
    ]);
    expect(set).toEqual({
      chips: [
        {
          kind: "file",
          key: "file:apps/web/src/index.css",
          path: "apps/web/src/index.css",
          name: "index.css",
        },
      ],
      moreCount: 0,
    });
  });

  it("lists the files a code search hit, from structured results or tool output", () => {
    const fileSearch = entry("search", {
      itemType: "file_search",
      structuredPayload: item({
        type: "file_search",
        pattern: "session",
        results: [{ fileName: "src/session.ts", line: 4 }, { fileName: "src/session.ts" }],
      }),
    });
    expect(workLogChips([fileSearch]).chips.map((chip) => chip.key)).toEqual([
      "file:src/session.ts",
    ]);

    const grep = entry("grep", {
      itemType: "dynamic_tool",
      toolTitle: "Grep",
      structuredPayload: item({
        type: "dynamic_tool",
        toolName: "Grep",
        input: { pattern: "auth" },
        output: { mode: "files_with_matches", filenames: ["/repo/src/auth.ts", "/repo/a.ts"] },
      }),
    });
    expect(workLogChips([grep]).chips.map((chip) => chip.key)).toEqual([
      "file:/repo/src/auth.ts",
      "file:/repo/a.ts",
    ]);
  });

  it("shows a fetched page as a web chip named by its domain", () => {
    const fetch = entry("fetch", {
      itemType: "web_search",
      structuredPayload: item({
        type: "web_search",
        results: [
          { title: "Routing – Next.js docs", url: "https://nextjs.org/docs/routing" },
          { url: "https://www.example.com/a" },
        ],
      }),
    });
    expect(workLogChips([fetch]).chips).toEqual([
      {
        kind: "web",
        key: "web:https://nextjs.org/docs/routing",
        label: "Routing – Next.js docs",
        url: "https://nextjs.org/docs/routing",
      },
      {
        kind: "web",
        key: "web:https://www.example.com/a",
        label: "example.com",
        url: "https://www.example.com/a",
      },
    ]);
  });

  it("gives commands and thoughts no chips", () => {
    expect(
      workLogChips([command("c", 0), entry("t", { itemType: "reasoning", tone: "thinking" })]),
    ).toEqual({ chips: [], moreCount: 0 });
  });

  it("compares chip sets by their keys", () => {
    const a = workLogChips([read("1", "a.ts")]);
    expect(workLogChipSetsEqual(a, workLogChips([read("2", "a.ts")]))).toBe(true);
    expect(workLogChipSetsEqual(a, workLogChips([read("2", "b.ts")]))).toBe(false);
  });
});

describe("searchOutputFilePaths", () => {
  it("reads paths from glob listings and grep's path:line:text lines", () => {
    expect(
      searchOutputFilePaths(
        [
          "Found 3 files",
          "./src/router.ts",
          "src/auth.ts:12:  const session = read()",
          "src/auth.ts:40:  return session",
          "C:\\repo\\main.go:7:func main()",
          "https://example.com/page.html",
          "not a path at all",
        ].join("\n"),
      ),
    ).toEqual(["src/router.ts", "src/auth.ts", "C:\\repo\\main.go"]);
  });

  it("stops at the path budget", () => {
    const output = Array.from({ length: 500 }, (_, index) => `src/file${index}.ts`).join("\n");
    expect(searchOutputFilePaths(output, 5)).toHaveLength(5);
    expect(searchOutputFilePaths(output).length).toBeLessThanOrEqual(50);
  });
});

describe("labels", () => {
  it("words the header for live, finished and stopped turns", () => {
    expect(workLogHeaderLabel({ state: "working", duration: "49s" })).toBe("Working for 49s");
    expect(workLogHeaderLabel({ state: "working", duration: null })).toBe("Working for 0s");
    expect(workLogHeaderLabel({ state: "worked", duration: "1m 3s" })).toBe("Worked for 1m 3s");
    expect(workLogHeaderLabel({ state: "worked", duration: null })).toBe("Worked");
    expect(workLogHeaderLabel({ state: "stopped", duration: "4s" })).toBe("You stopped after 4s");
    expect(workLogHeaderLabel({ state: "stopped", duration: null })).toBe(
      "You stopped this response",
    );
  });

  it("names a page by its title, else its domain", () => {
    expect(webChipLabel("https://docs.rs/x", "  x – Rust ")).toBe("x – Rust");
    expect(webChipLabel("https://www.docs.rs/x", undefined)).toBe("docs.rs");
    expect(webChipLabel("not a url", undefined)).toBeNull();
  });
});
