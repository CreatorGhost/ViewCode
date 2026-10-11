import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  REVIEW_FINDING_MAX_DETAIL_CHARS,
  REVIEW_FINDINGS_MAX_FINDINGS,
  REVIEW_FINDINGS_MAX_NEEDS_CHECKING,
  ReviewFinding,
  ReviewFindingsReport,
} from "./reviewFindings.ts";

const decodeFinding = Schema.decodeUnknownOption(ReviewFinding);
const decodeReport = Schema.decodeUnknownOption(ReviewFindingsReport);

const finding = {
  severity: "important",
  confidence: 85,
  path: "src/a.ts",
  line: 10,
  title: "Off by one",
  detail: "The loop skips the last item.",
};

const report = (overrides: Record<string, unknown> = {}) => ({
  verdict: "request-changes",
  mergeConfidence: 2,
  reviewEffort: 3,
  findings: [finding],
  needsChecking: [],
  ...overrides,
});

describe("ReviewFinding", () => {
  it("trims text but keeps a suggested fix's indentation", () => {
    const decoded = decodeFinding({
      ...finding,
      title: "  Off by one  ",
      suggestedFix: "  for (let i = 0; i <= n; i++) {}\n",
    });
    expect(Option.getOrThrow(decoded)).toMatchObject({
      title: "Off by one",
      suggestedFix: "  for (let i = 0; i <= n; i++) {}\n",
    });
  });

  it("rejects out-of-range confidence, empty text and over-long detail", () => {
    expect(Option.isNone(decodeFinding({ ...finding, confidence: 101 }))).toBe(true);
    expect(Option.isNone(decodeFinding({ ...finding, confidence: 79.5 }))).toBe(true);
    expect(Option.isNone(decodeFinding({ ...finding, title: "   " }))).toBe(true);
    expect(
      Option.isNone(
        decodeFinding({ ...finding, detail: "x".repeat(REVIEW_FINDING_MAX_DETAIL_CHARS + 1) }),
      ),
    ).toBe(true);
    expect(Option.isNone(decodeFinding({ ...finding, line: 0 }))).toBe(true);
  });

  it("needs a line at or before endLine", () => {
    expect(Option.isSome(decodeFinding({ ...finding, endLine: 12 }))).toBe(true);
    expect(Option.isNone(decodeFinding({ ...finding, endLine: 9 }))).toBe(true);
    const { line: _line, ...withoutLine } = finding;
    expect(Option.isNone(decodeFinding({ ...withoutLine, endLine: 9 }))).toBe(true);
    expect(Option.isSome(decodeFinding(withoutLine))).toBe(true);
  });
});

describe("ReviewFindingsReport", () => {
  it("bounds the scores", () => {
    expect(Option.isSome(decodeReport(report()))).toBe(true);
    expect(Option.isNone(decodeReport(report({ mergeConfidence: 6 })))).toBe(true);
    expect(Option.isNone(decodeReport(report({ reviewEffort: 0 })))).toBe(true);
    expect(Option.isNone(decodeReport(report({ verdict: "lgtm" })))).toBe(true);
  });

  it("caps how many findings one review carries", () => {
    expect(
      Option.isSome(
        decodeReport(
          report({ findings: Array.from({ length: REVIEW_FINDINGS_MAX_FINDINGS }, () => finding) }),
        ),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeReport(
          report({
            findings: Array.from({ length: REVIEW_FINDINGS_MAX_FINDINGS + 1 }, () => finding),
          }),
        ),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        decodeReport(
          report({
            needsChecking: Array.from(
              { length: REVIEW_FINDINGS_MAX_NEEDS_CHECKING + 1 },
              () => finding,
            ),
          }),
        ),
      ),
    ).toBe(true);
  });
});
