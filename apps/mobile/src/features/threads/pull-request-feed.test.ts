import { describe, expect, it } from "vite-plus/test";

import { insertPullRequestFeedEntries } from "./pull-request-feed";

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
