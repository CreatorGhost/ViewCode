import { type PrFlowSources, prFlowFromPullRequest } from "@t3tools/client-runtime/pr-flow";
import type { PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { insertPullRequestFeedEntries, pullRequestCardPresentation } from "./pull-request-feed";

const entry = (id: string, type: string, createdAt: string) => ({ id, type, createdAt });
const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

const FEED = [
  entry("ask", "message", at(0)),
  entry("work-1", "activity-group", at(1)),
  entry("work-2", "work-toggle", at(3)),
  entry("answer", "message", at(5)),
];

const ids = (entries: ReadonlyArray<{ readonly id: string }>) => entries.map((item) => item.id);

describe("insertPullRequestFeedEntries", () => {
  it("places a card where the thread got the pull request", () => {
    const result = insertPullRequestFeedEntries(FEED, {
      pullRequests: [{ key: "gh#1", anchorAt: at(0) }],
      currentKey: "gh#1",
    });
    expect(ids(result)).toEqual(["ask", "pull-request:gh#1", "work-1", "work-2", "answer"]);
    expect(result[1]).toMatchObject({
      type: "pull-request",
      pullRequestKey: "gh#1",
      current: true,
    });
  });

  it("never splits a turn's work log, and keeps older cards first", () => {
    const result = insertPullRequestFeedEntries(FEED, {
      pullRequests: [
        { key: "gh#2", anchorAt: at(2) },
        { key: "gh#1", anchorAt: at(2) },
        { key: "gh#3", anchorAt: at(9) },
      ],
      currentKey: "gh#3",
    });
    expect(ids(result)).toEqual([
      "ask",
      "work-1",
      "work-2",
      "pull-request:gh#2",
      "pull-request:gh#1",
      "answer",
      "pull-request:gh#3",
    ]);
    expect(result.filter((item) => "current" in item && item.current)).toHaveLength(1);
  });

  it("returns the same feed when the thread has no pull requests", () => {
    expect(insertPullRequestFeedEntries(FEED, { pullRequests: [], currentKey: null })).toBe(FEED);
  });
});

const OPEN = {
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  title: "Add retries",
  state: "open",
  headBranch: "feat/retries",
  baseBranch: "main",
} as const;
const IDLE: PrFlowSources = {
  graph: null,
  checks: null,
  resolveAsked: false,
  merging: false,
  command: null,
};
const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});
const present = (
  pr: Partial<Parameters<typeof prFlowFromPullRequest>[0]>,
  sources: Partial<PrFlowSources> = {},
) => {
  const flow = prFlowFromPullRequest({ ...OPEN, ...pr }, { ...IDLE, ...sources });
  if (flow === null) throw new Error("expected a flow");
  return pullRequestCardPresentation(flow);
};

describe("pullRequestCardPresentation", () => {
  it("glows and warns while the pull request conflicts with its base", () => {
    const card = present({ mergeability: "conflicting" });
    expect(card.conflictGlow).toBe(true);
    expect(card.status.label).toBe("Conflicts with main");
    expect(card.status.tint).toBe("accent-warning-foreground");
    expect(present({ mergeability: "mergeable" }).conflictGlow).toBe(false);
  });

  it("summarises checks and names the failed ones before the running ones", () => {
    const card = present(
      {},
      {
        checks: [
          check("lint", "success"),
          check("e2e", "pending"),
          check("unit", "failure"),
          check("docs", "skipped"),
        ],
      },
    );
    expect(card.checks?.label).toBe("1 of 4 checks failed");
    expect(card.namedChecks.map((item) => `${item.name}:${item.result}`)).toEqual([
      "unit:failed",
      "e2e:running",
    ]);
    expect(card.moreChecks).toBe(0);
  });

  it("says when checks are still running, and how many passed once done", () => {
    expect(
      present({}, { checks: [check("lint", "success"), check("e2e", "pending")] }).checks?.label,
    ).toBe("Checks running, 1 of 2 done");
    expect(
      present({}, { checks: [check("lint", "success"), check("docs", "skipped")] }).checks?.label,
    ).toBe("1 passed, 1 skipped");
    expect(present({}, { checks: [check("lint", "success")] }).checks?.label).toBe(
      "1 check passed",
    );
    expect(present({}).checks).toBeNull();
  });

  it("reads as merged once the host merged it", () => {
    const card = present({ state: "merged" });
    expect(card.status.label).toBe("Merged into main");
    expect(card.status.tint).toBe("accent-adaptive-violet-600-400");
  });
});
