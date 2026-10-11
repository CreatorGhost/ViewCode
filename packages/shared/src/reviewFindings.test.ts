import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  REVIEW_FINDING_MAX_DETAIL_CHARS,
  REVIEW_FINDING_MAX_PATH_CHARS,
  REVIEW_FINDING_MAX_RULE_CHARS,
  REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS,
  REVIEW_FINDING_MAX_TITLE_CHARS,
  REVIEW_FINDINGS_MAX_FINDINGS,
} from "@t3tools/contracts";

import {
  buildReviewFixMessage,
  fencedCode,
  readReviewFindings,
  reviewFindingLocation,
} from "./reviewFindings.ts";

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

  it("keeps a full Fix all under the turn input limit", () => {
    const longest = {
      severity: "important",
      confidence: 100,
      path: `${"d/".repeat(REVIEW_FINDING_MAX_PATH_CHARS / 2 - 3)}a.ts`,
      line: 99_999,
      endLine: 100_000,
      title: "t".repeat(REVIEW_FINDING_MAX_TITLE_CHARS),
      detail: "d".repeat(REVIEW_FINDING_MAX_DETAIL_CHARS),
      suggestedFix: "f".repeat(REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS),
      rule: "r".repeat(REVIEW_FINDING_MAX_RULE_CHARS),
      preExisting: true,
    } as const;
    const text = buildReviewFixMessage({
      reviewTitle: "Review: #1 A long title",
      target: {
        kind: "pull-request",
        host: "github.com",
        repository: "o/r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
      },
      findings: Array.from({ length: REVIEW_FINDINGS_MAX_FINDINGS }, () => ({
        finding: longest,
        needsChecking: true,
      })),
    });
    expect(text.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
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
});
