import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  REVIEW_FINDING_MAX_DETAIL_CHARS,
  REVIEW_FINDING_MAX_PATH_CHARS,
  REVIEW_FINDING_MAX_RULE_CHARS,
  REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS,
  REVIEW_FINDING_MAX_TITLE_CHARS,
  REVIEW_FINDINGS_MAX_FINDINGS,
  REVIEW_FINDINGS_MAX_NEEDS_CHECKING,
  ReviewFindingsToFix,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildReviewFixMessage,
  buildReviewFromFindings,
  fencedCode,
  postedReviewFindings,
  readReviewFindings,
  recentRatedReviewFindings,
  reviewCommentableLines,
  reviewFindingRatings,
  reviewFindingCommentBody,
  reviewFindingLocation,
  reviewFindingsMode,
  reviewSubmitVerdictFor,
} from "./reviewFindings.ts";

const ratingActivity = (
  findingsActivityId: string,
  key: string,
  rating: "up" | "down" | null,
  projectId = "project-1",
  title = `${findingsActivityId} ${key}`,
) => ({
  kind: "viewcode.review.rating",
  payload: {
    findingsActivityId,
    key,
    rating,
    projectId,
    finding: { title, severity: "nit", path: "src/a.ts" },
    timelineBypass: true,
  },
});

describe("reviewFindingRatings", () => {
  it("keeps each finding's latest rating and forgets one taken back", () => {
    const ratings = reviewFindingRatings(
      [
        ratingActivity("review", "finding:0", "up"),
        ratingActivity("review", "finding:0", "down"),
        ratingActivity("review", "finding:1", "up"),
        ratingActivity("review", "finding:1", null),
        ratingActivity("other", "finding:2", "up"),
        { kind: "viewcode.review.rating", payload: { rating: "sideways" } },
      ],
      "review",
    );
    expect([...ratings]).toEqual([["finding:0", "down"]]);
  });
});

describe("recentRatedReviewFindings", () => {
  it("lists the project's findings by their latest rating, newest last and bounded", () => {
    const rated = recentRatedReviewFindings(
      [
        ratingActivity("a", "finding:0", "down", "project-1", "Too picky"),
        ratingActivity("a", "finding:1", "up", "project-1", "Real bug"),
        ratingActivity("b", "finding:0", "up", "project-2", "Other project"),
        ratingActivity("a", "finding:2", "up", "project-1", "Taken back"),
        ratingActivity("a", "finding:2", null, "project-1", "Taken back"),
        // Rated again: it moves to the end with its new rating.
        ratingActivity("a", "finding:0", "up", "project-1", "Too picky"),
      ],
      "project-1",
      30,
    );
    expect(rated.map((entry) => [entry.title, entry.rating])).toEqual([
      ["Real bug", "up"],
      ["Too picky", "up"],
    ]);
    expect(
      recentRatedReviewFindings(
        Array.from({ length: 40 }, (_, index) => ratingActivity("a", `finding:${index}`, "down")),
        "project-1",
        30,
      ).map((entry) => entry.title)[0],
    ).toBe("a finding:10");
  });
});

describe("reviewFindingLocation", () => {
  it("cites a file, a line or a range", () => {
    expect(reviewFindingLocation({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(reviewFindingLocation({ path: "src/a.ts", line: 4 })).toBe("src/a.ts:4");
    expect(reviewFindingLocation({ path: "src/a.ts", line: 4, endLine: 4 })).toBe("src/a.ts:4");
    expect(reviewFindingLocation({ path: "src/a.ts", line: 4, endLine: 9 })).toBe("src/a.ts:4-9");
  });
});

describe("fencedCode", () => {
  it("keeps indentation and outgrows backticks in the code", () => {
    expect(fencedCode("  const a = 1;\n", "src/a.ts")).toBe("```ts\n  const a = 1;\n```");
    expect(fencedCode("const s = ````;", "Makefile")).toBe("`````\nconst s = ````;\n`````");
  });
});

describe("buildReviewFixMessage", () => {
  const finding = {
    severity: "blocker",
    confidence: 90,
    path: "src/run.ts",
    line: 12,
    endLine: 14,
    title: "Shell injection",
    detail: "The branch name reaches `sh -c` unquoted.",
    suggestedFix: "  execFile('git', ['checkout', branch]);",
    rule: '"Never build shell strings" (AGENTS.md)',
  } as const;

  it("asks for verification first and carries everything the finding says", () => {
    const text = buildReviewFixMessage({
      reviewTitle: "Review: #7 Run things",
      target: {
        kind: "pull-request",
        host: "github.com",
        repository: "o/r",
        number: 7,
        url: "https://github.com/o/r/pull/7",
      },
      findings: [
        { finding, needsChecking: false },
        {
          finding: { ...finding, title: "Maybe racy", severity: "question", preExisting: true },
          needsChecking: true,
        },
      ],
    });
    expect(text).toBe(
      [
        "Fix these review findings from \"Review: #7 Run things\" on PR #7 (https://github.com/o/r/pull/7). Another agent found them: verify each against the code first; fix the ones that hold, skip the ones that don't and say why. Run the project's checks for what you touch.",
        "1. Shell injection\nSeverity: blocker · Confidence: 90 · Location: src/run.ts:12-14\n\nThe branch name reaches `sh -c` unquoted.\n\nRule: \"Never build shell strings\" (AGENTS.md)\n\nSuggested fix:\n```ts\n  execFile('git', ['checkout', branch]);\n```",
        "2. Maybe racy\nSeverity: question · Confidence: 90 · Location: src/run.ts:12-14 · Pre-existing: the change makes it worse or reachable · Needs checking: the reviewer could not settle it\n\nThe branch name reaches `sh -c` unquoted.\n\nRule: \"Never build shell strings\" (AGENTS.md)\n\nSuggested fix:\n```ts\n  execFile('git', ['checkout', branch]);\n```",
      ].join("\n\n"),
    );
  });

  it("names a local review and a single finding", () => {
    const text = buildReviewFixMessage({
      reviewTitle: "Review local",
      target: { kind: "local" },
      findings: [{ finding: { ...finding, suggestedFix: undefined }, needsChecking: false }],
    });
    expect(
      text.startsWith('Fix this review finding from "Review local" on the local changes.'),
    ).toBe(true);
    expect(text).not.toContain("Suggested fix");
  });

  it("keeps any Fix all the schema accepts under the turn input limit", () => {
    // Every field at its longest, and a suggested fix of backticks for the longest fence.
    const longest = {
      severity: "important",
      confidence: 100,
      path: `${"d/".repeat(REVIEW_FINDING_MAX_PATH_CHARS / 2 - 3)}a.ts`,
      line: 99_999,
      endLine: 100_000,
      title: "t".repeat(REVIEW_FINDING_MAX_TITLE_CHARS),
      detail: "d".repeat(REVIEW_FINDING_MAX_DETAIL_CHARS),
      suggestedFix: "`".repeat(REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS),
      rule: "r".repeat(REVIEW_FINDING_MAX_RULE_CHARS),
      preExisting: true,
    } as const;
    const accepts = Schema.is(ReviewFindingsToFix);
    const items = (count: number, finding: typeof longest | typeof typical) =>
      Array.from({ length: count }, () => ({ finding, needsChecking: true }));
    let count = 1;
    while (accepts(items(count + 1, longest))) count++;
    const text = buildReviewFixMessage({
      reviewTitle: `Review: #1 ${"a".repeat(500)}`,
      target: {
        kind: "pull-request",
        host: "github.com",
        repository: "o/r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
      },
      findings: items(count, longest),
    });
    expect(text.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

    // A whole review of ordinary findings is one Fix all.
    const typical = {
      severity: "nit",
      confidence: 80,
      path: "src/components/chat/ReviewFindingsView.tsx",
      line: 120,
      title: "t".repeat(80),
      detail: "d".repeat(700),
      suggestedFix: "f".repeat(600),
    } as const;
    expect(
      accepts(items(REVIEW_FINDINGS_MAX_FINDINGS + REVIEW_FINDINGS_MAX_NEEDS_CHECKING, typical)),
    ).toBe(true);
  });
});

describe("readReviewFindings", () => {
  it("reads only a well-formed findings activity", () => {
    const payload = {
      verdict: "approve",
      mergeConfidence: 5,
      reviewEffort: 1,
      findings: [],
      needsChecking: [],
      target: { kind: "local" },
    };
    expect(readReviewFindings({ kind: "viewcode.review.findings", payload })).toEqual(payload);
    expect(
      readReviewFindings({ kind: "viewcode.review.findings", payload: { verdict: "approve" } }),
    ).toBeUndefined();
    expect(readReviewFindings({ kind: "html.render", payload })).toBeUndefined();
  });

  it("reads findings recorded before they had a mode as fixes", () => {
    const payload = {
      verdict: "approve",
      mergeConfidence: 5,
      reviewEffort: 1,
      findings: [],
      needsChecking: [],
      target: { kind: "local" },
    };
    const legacy = readReviewFindings({ kind: "viewcode.review.findings", payload });
    expect(legacy && reviewFindingsMode(legacy)).toBe("fix");
    const comments = readReviewFindings({
      kind: "viewcode.review.findings",
      payload: { ...payload, mode: "comment" },
    });
    expect(comments && reviewFindingsMode(comments)).toBe("comment");
  });
});

describe("reviewSubmitVerdictFor", () => {
  it("requests changes or approves where the reviewer did, and comments otherwise", () => {
    expect(reviewSubmitVerdictFor("request-changes")).toBe("request-changes");
    expect(reviewSubmitVerdictFor("approve")).toBe("approve");
    expect(reviewSubmitVerdictFor("approve-with-nits")).toBe("comment");
  });
});

const PATCH = [
  "diff --git a/src/run.ts b/src/run.ts",
  "index 1111111..2222222 100644",
  "--- a/src/run.ts",
  "+++ b/src/run.ts",
  "@@ -10,4 +10,4 @@ export function run() {",
  "   const a = 1;",
  "-  exec(branch);",
  "--- a removed line that looks like a header",
  "+  execFile('git', [branch]);",
  "+  log(a);",
  "   return a;",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 90%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "--- a/old/name.ts",
  "+++ b/new/name.ts",
  "@@ -1 +1 @@",
  "-export const x = 1;",
  "+export const x = 2;",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "",
].join("\n");

describe("reviewCommentableLines", () => {
  it("knows the added and unchanged lines of the head, by the hunks' own counts", () => {
    const lines = reviewCommentableLines(PATCH);
    expect([...lines.keys()]).toEqual(["src/run.ts", "new/name.ts"]);
    const run = lines.get("src/run.ts")!;
    expect(run.oldPath).toBeUndefined();
    expect([...run.lines.entries()]).toEqual([
      [10, { kind: "context", oldLine: 10, newLine: 10, side: "right" }],
      [11, { kind: "added", newLine: 11 }],
      [12, { kind: "added", newLine: 12 }],
      [13, { kind: "context", oldLine: 13, newLine: 13, side: "right" }],
    ]);
    expect(lines.get("new/name.ts")).toEqual({
      oldPath: "old/name.ts",
      lines: new Map([[1, { kind: "added", newLine: 1 }]]),
    });
  });
});

describe("buildReviewFromFindings", () => {
  const base = { severity: "important", confidence: 92, title: "Shell injection" } as const;
  const onLine = {
    ...base,
    path: "src/run.ts",
    line: 11,
    detail: "This still reaches a shell.",
    suggestedFix: "execFile('git', [branch]);",
  };
  const offDiff = { ...base, path: "src/run.ts", line: 40, detail: "Same problem here." };
  const noLine = { ...base, path: "README.md", detail: "The docs still say exec." };
  const renamed = { ...base, path: "new/name.ts", line: 1, detail: "Why 2?" };

  it("puts a finding on its line when the diff shows it, and the rest in the review's text", () => {
    const review = buildReviewFromFindings({
      overallComment: "  Thanks, a few things.  ",
      findings: [
        { key: "finding:0", finding: onLine },
        { key: "finding:1", finding: offDiff },
        { key: "finding:2", finding: noLine },
        { key: "finding:3", finding: renamed },
      ],
      commentable: reviewCommentableLines(PATCH),
    });
    expect(review.placements).toEqual([
      { key: "finding:0", placement: "inline" },
      { key: "finding:1", placement: "body" },
      { key: "finding:2", placement: "body" },
      { key: "finding:3", placement: "inline" },
    ]);
    expect(review.comments).toEqual([
      {
        path: "src/run.ts",
        position: { kind: "added", newLine: 11 },
        body: "This still reaches a shell.\n\n```ts\nexecFile('git', [branch]);\n```",
      },
      {
        path: "new/name.ts",
        oldPath: "old/name.ts",
        position: { kind: "added", newLine: 1 },
        body: "Why 2?",
      },
    ]);
    expect(review.body).toBe(
      [
        "Thanks, a few things.",
        "**Shell injection** (`src/run.ts:40`)\n\nSame problem here.",
        "**Shell injection** (`README.md`)\n\nThe docs still say exec.",
      ].join("\n\n"),
    );
  });

  it("puts every finding in the text when the diff is unknown", () => {
    const review = buildReviewFromFindings({
      overallComment: "",
      findings: [{ key: "finding:0", finding: onLine }],
      commentable: null,
    });
    expect(review.comments).toEqual([]);
    expect(review.placements).toEqual([{ key: "finding:0", placement: "body" }]);
    expect(review.body).toBe(reviewFindingCommentBody(onLine, "body"));
  });
});

describe("postedReviewFindings", () => {
  const posted = (findingsActivityId: string, findings: ReadonlyArray<unknown>) => ({
    kind: "viewcode.review.posted",
    payload: {
      findingsActivityId,
      verdict: "comment",
      url: "https://github.com/o/r/pull/7",
      findings,
    },
  });

  it("collects what each review posted from one findings activity", () => {
    const result = postedReviewFindings(
      [
        posted("findings-1", [{ key: "finding:0", placement: "inline" }]),
        posted("findings-0", [{ key: "finding:1", placement: "inline" }]),
        { kind: "viewcode.review.findings", payload: {} },
        posted("findings-1", [{ key: "check:2", placement: "body" }]),
        posted("findings-1", [{ key: "not a key", placement: "body" }]),
      ],
      "findings-1",
    );
    expect([...result.entries()]).toEqual([
      [
        "finding:0",
        { placement: "inline", url: "https://github.com/o/r/pull/7", verdict: "comment" },
      ],
      ["check:2", { placement: "body", url: "https://github.com/o/r/pull/7", verdict: "comment" }],
    ]);
  });
});
