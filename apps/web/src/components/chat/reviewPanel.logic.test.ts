import type { FileDiffMetadata } from "@pierre/diffs";
import { reviewFindingEntries } from "@t3tools/client-runtime/review-findings";
import { describe, expect, it } from "vite-plus/test";

import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  firstFindingToReveal,
  placeReviewFindings,
  reviewFileCollapsed,
  reviewFindingsFixPrompt,
  reviewFixAllInitiallyTicked,
  reviewFixAllMode,
  reviewIssueOrder,
  reviewPostAllWaits,
} from "./reviewPanel.logic";

describe("placeReviewFindings", () => {
  // Only the hunk ranges matter here; the viewer fills the rest in when it renders.
  const file = (fileKey: string, path: string, hunks: ReadonlyArray<[number, number]>) => ({
    fileKey,
    path,
    fileDiff: {
      name: path,
      hunks: hunks.map(([additionStart, additionCount]) => ({
        deletionStart: additionStart,
        deletionCount: 0,
        additionStart,
        additionCount,
      })),
    } as unknown as FileDiffMetadata,
  });
  const files = [file("a", "src/a.ts", [[10, 5]]), file("b", "src/b.ts", [[1, 3]])];
  const finding = (path: string, line?: number, endLine?: number) => ({
    severity: "nit" as const,
    confidence: 70,
    path,
    ...(line === undefined ? {} : { line }),
    ...(endLine === undefined ? {} : { endLine }),
    title: `${path}:${line ?? "-"}`,
    detail: "Detail.",
  });

  it("pins findings under the diff in reading order and lists the rest under General", () => {
    const entries = reviewFindingEntries({
      findings: [
        finding("src/b.ts", 2),
        finding("src/a.ts", 13, 20),
        finding("src/a.ts", 11, 12),
        finding("src/a.ts"),
        finding("src/a.ts", 40),
        finding("src/c.ts", 1),
      ],
      needsChecking: [finding("src/a.ts", 10)],
    });
    const { general, placed } = placeReviewFindings(entries, files);
    expect(general.map((entry) => entry.key)).toEqual(["finding:3", "finding:4", "finding:5"]);
    // All nits here: General first, then the diff in reading order.
    expect(reviewIssueOrder(general, placed)).toEqual([
      "finding:3",
      "finding:4",
      "finding:5",
      "check:0",
      "finding:2",
      "finding:1",
      "finding:0",
    ]);
    expect(
      placed.map(({ entry, fileKey, startLine, lineNumber }) => [
        entry.key,
        fileKey,
        startLine,
        lineNumber,
      ]),
    ).toEqual([
      ["check:0", "a", 10, 10],
      ["finding:2", "a", 11, 12],
      // The range runs past the hunk, so the finding sits under its first line.
      ["finding:1", "a", 13, 13],
      ["finding:0", "b", 2, 2],
    ]);
  });
});

describe("reviewFindingsFixPrompt", () => {
  const blocker = {
    severity: "blocker" as const,
    confidence: 90,
    path: "apps/web/src/a.ts",
    line: 12,
    endLine: 14,
    title: "Stale label",
    detail: "The label keeps the old count.",
    suggestedFix: "const label = String(count);\n",
  };
  const question = {
    severity: "question" as const,
    confidence: 50,
    path: "README.md",
    title: "Is this still true?",
    detail: "The docs may be out of date.",
  };

  it("asks to verify one finding first, with its lines as a chip", () => {
    const [entry] = reviewFindingEntries({ findings: [blocker], needsChecking: [] });
    const { prompt, comments } = reviewFindingsFixPrompt({
      activityId: "activity-1",
      entries: [entry!],
    });
    expect(comments).toEqual([
      expect.objectContaining({
        id: "review-finding:activity-1:finding:0",
        filePath: "apps/web/src/a.ts",
        startIndex: 11,
        endIndex: 13,
        rangeLabel: "L12 to L14",
        text: "",
        diff: "",
      }),
    ]);
    const chip = formatInlineContextReference(reviewCommentContextReference(comments[0]!));
    expect(chip).toContain("a.ts L12 to L14");
    expect(prompt).toBe(
      [
        `Verify this issue exists and fix it: ${chip}`,
        "**Stale label**",
        "The label keeps the old count.",
        "Suggested fix:\n\n```ts\nconst label = String(count);\n```",
      ].join("\n\n"),
    );
  });

  it("numbers several findings in one request and says which nobody settled", () => {
    const entries = reviewFindingEntries({ findings: [blocker], needsChecking: [question] });
    const { prompt, comments } = reviewFindingsFixPrompt({ activityId: "activity-1", entries });
    expect(comments.map((comment) => comment.rangeLabel)).toEqual(["L12 to L14", "file"]);
    expect(prompt).toMatch(/^Verify each of these issues exists and fix the ones that do/);
    expect(prompt).toContain("1. [a.ts L12 to L14]");
    expect(prompt).toContain("2. [README.md file](t3-context://v1/review-comment/");
    expect(prompt).toContain("The reviewer could not settle this one.");
  });
});

describe("firstFindingToReveal", () => {
  const order = ["check:0", "finding:1"] as const;
  it("goes to the first finding once the change is read, once, unless the reader scrolled", () => {
    const reveal = (input: Partial<Parameters<typeof firstFindingToReveal>[0]>) =>
      firstFindingToReveal({
        order,
        diffPending: false,
        revealed: false,
        readerScrolled: false,
        ...input,
      });
    expect(reveal({})).toBe("check:0");
    expect(reveal({ diffPending: true })).toBeNull();
    expect(reveal({ revealed: true })).toBeNull();
    expect(reveal({ readerScrolled: true })).toBeNull();
    expect(reveal({ order: [] })).toBeNull();
  });
});

describe("reviewFileCollapsed", () => {
  it("folds files without findings and opens those with, each until toggled", () => {
    const withFindings = new Set(["a"]);
    expect(reviewFileCollapsed("a", withFindings, new Set())).toBe(false);
    expect(reviewFileCollapsed("b", withFindings, new Set())).toBe(true);
    // Show all files toggles every file without findings open.
    expect(reviewFileCollapsed("b", withFindings, new Set(["b"]))).toBe(false);
    expect(reviewFileCollapsed("a", withFindings, new Set(["a"]))).toBe(true);
  });
});

describe("Fix all and Post all", () => {
  it("sends one finding straight away and lists several first", () => {
    expect(reviewFixAllMode(0)).toBe("none");
    expect(reviewFixAllMode(1)).toBe("send");
    expect(reviewFixAllMode(3)).toBe("choose");
  });

  it("holds Post all while the review works, never one finding or ticked ones", () => {
    expect(reviewPostAllWaits({ commentMode: true, tickedCount: 0, stillReviewing: true })).toBe(
      true,
    );
    expect(reviewPostAllWaits({ commentMode: true, tickedCount: 2, stillReviewing: true })).toBe(
      false,
    );
    expect(reviewPostAllWaits({ commentMode: true, tickedCount: 0, stillReviewing: false })).toBe(
      false,
    );
    expect(reviewPostAllWaits({ commentMode: false, tickedCount: 0, stillReviewing: true })).toBe(
      false,
    );
  });
});

describe("reviewIssueOrder by severity", () => {
  const entry = (key: string, severity: "blocker" | "important" | "nit" | "question") => ({
    key: key as `finding:${number}`,
    finding: { severity, confidence: 80, path: "a.ts", title: key, detail: "Detail." },
  });
  it("lists the most severe first, keeping file order within a severity", () => {
    expect(
      reviewIssueOrder(
        [entry("finding:9", "question")],
        [
          { entry: entry("finding:0", "important") },
          { entry: entry("finding:1", "important") },
          { entry: entry("finding:2", "question") },
          { entry: entry("finding:3", "blocker") },
        ],
      ),
    ).toEqual(["finding:3", "finding:0", "finding:1", "finding:9", "finding:2"]);
  });
});

describe("reviewFixAllInitiallyTicked", () => {
  const entry = (severity: "important" | "question", needsChecking = false) => ({
    key: "finding:0" as const,
    needsChecking,
    finding: { severity, confidence: 80, path: "a.ts", title: "T", detail: "Detail." },
  });
  it("ticks fixes not sent yet, and leaves questions, unsettled and sent findings to the reader", () => {
    expect(reviewFixAllInitiallyTicked(entry("important"), {})).toBe(true);
    expect(reviewFixAllInitiallyTicked(entry("question"), {})).toBe(false);
    expect(reviewFixAllInitiallyTicked(entry("important", true), {})).toBe(false);
    expect(
      reviewFixAllInitiallyTicked(entry("important"), { "finding:0": { title: "Chat" } }),
    ).toBe(false);
  });
});
