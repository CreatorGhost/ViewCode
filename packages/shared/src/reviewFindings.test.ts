import { describe, expect, it } from "vite-plus/test";

import { fencedCode, readReviewFindings, reviewFindingLocation } from "./reviewFindings.ts";

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
