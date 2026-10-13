import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewWorkLine } from "./reviewProgress.logic";

const tool = (
  id: string,
  summary: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.completed",
  summary,
  payload,
  turnId: null,
  createdAt: `2026-10-01T10:00:0${id.length}.000Z`,
});

const findings = (complete: boolean): OrchestrationThreadActivity => ({
  id: EventId.make("findings"),
  tone: "info",
  kind: "viewcode.review.findings",
  summary: "Review so far: request changes, 1 finding",
  payload: {
    verdict: "request-changes",
    mergeConfidence: 2,
    reviewEffort: 2,
    findings: [
      {
        severity: "important",
        confidence: 90,
        path: "src/retry.ts",
        line: 4,
        title: "Retry never stops",
        detail: "Detail.",
      },
    ],
    needsChecking: [],
    target: { kind: "local" },
    complete,
  },
  turnId: null,
  createdAt: "2026-10-01T10:00:09.000Z",
});

describe("reviewWorkLine", () => {
  it("says how many findings were sent, never the tool's raw answer", () => {
    const submit = tool("s", "submit_review_findings", {
      title: "submit_review_findings",
      detail: '{"target":"local","findings":1,"needsChecking":0,"message":"Recorded and shown"}',
    });
    expect(reviewWorkLine([findings(false), submit], undefined)).toBe("Sent 1 finding so far");
    expect(reviewWorkLine([findings(true), submit], undefined)).toBe("Sent 1 finding");
  });

  it("names a step by its tool when its words would be raw output", () => {
    const line = reviewWorkLine(
      [tool("x", "Lookup", { title: "Lookup", detail: '{"rows":[1,2,3]}' })],
      undefined,
    );
    expect(line).not.toBeNull();
    expect(line).not.toContain("{");
  });

  it("is nothing before the reviewer calls a tool", () => {
    expect(reviewWorkLine([], undefined)).toBeNull();
  });
});
