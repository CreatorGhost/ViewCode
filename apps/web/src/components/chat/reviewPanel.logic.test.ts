import {
  EventId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  ThreadId,
  type ReviewFindingsTarget,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  placeReviewFindings,
  reviewFindingEntries,
  reviewSourceCandidates,
  selectReviewFindingsSource,
} from "./reviewPanel.logic";

const prTarget = (number: number): ReviewFindingsTarget => ({
  kind: "pull-request",
  host: "github.com",
  repository: "t3tools/t3code",
  number,
  url: `https://github.com/t3tools/t3code/pull/${number}`,
});

const findingsActivity = (
  id: string,
  createdAt: string,
  target: ReviewFindingsTarget = prTarget(7),
) => ({
  id: EventId.make(id),
  kind: REVIEW_FINDINGS_ACTIVITY_KIND,
  createdAt,
  payload: {
    verdict: "request-changes",
    mergeConfidence: 2,
    reviewEffort: 3,
    findings: [
      {
        severity: "blocker",
        confidence: 90,
        path: "src/a.ts",
        line: 4,
        title: "Null deref",
        detail: "It throws.",
      },
    ],
    needsChecking: [],
    target,
  },
});

const otherActivity = (id: string, createdAt: string) => ({
  id: EventId.make(id),
  kind: "tool.completed",
  createdAt,
  payload: {},
});

type Activity = { id: EventId; kind: string; payload: unknown; createdAt: string };

const thread = (id: string, activities: ReadonlyArray<Activity>) => ({
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  activities,
});

// Stored with the host's casing; keys compare case-insensitively.
const PR_7 = { host: "github.com", repository: "T3Tools/T3Code", number: 7 };

describe("selectReviewFindingsSource", () => {
  it("shows the thread's own latest findings, a re-review replacing the earlier set", () => {
    const source = selectReviewFindingsSource({
      thread: thread("review", [
        findingsActivity("first", "2026-08-01T00:00:00.000Z"),
        otherActivity("tool", "2026-08-01T00:01:00.000Z"),
        findingsActivity("second", "2026-08-01T00:02:00.000Z", { kind: "local" }),
      ]),
      pullRequests: [],
      // Ignored while the thread has findings of its own.
      linkedThreads: [thread("other", [findingsActivity("newer", "2026-09-01T00:00:00.000Z")])],
    });
    expect(source?.threadId).toBe("review");
    expect(source?.activityId).toBe("second");
    expect(source?.findings.target).toEqual({ kind: "local" });
  });

  it("shows the newest review of the thread's pull request from a linked thread", () => {
    const source = selectReviewFindingsSource({
      thread: thread("work", []),
      pullRequests: [PR_7],
      linkedThreads: [
        thread("old-review", [findingsActivity("old", "2026-08-01T00:00:00.000Z")]),
        thread("new-review", [findingsActivity("new", "2026-08-03T00:00:00.000Z")]),
        // A review of another layer of the stack is not about this pull request.
        thread("stack-review", [
          findingsActivity("stack", "2026-08-05T00:00:00.000Z", prTarget(8)),
        ]),
        thread("local-review", [
          findingsActivity("local", "2026-08-06T00:00:00.000Z", { kind: "local" }),
        ]),
      ],
    });
    expect(source).toMatchObject({
      threadId: "new-review",
      threadTitle: "Thread new-review",
      activityId: "new",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("shows nothing for a payload that does not decode", () => {
    const broken = { ...findingsActivity("broken", "2026-08-01T00:00:00.000Z"), payload: {} };
    expect(
      selectReviewFindingsSource({
        thread: thread("work", [broken]),
        pullRequests: [],
        linkedThreads: [],
      }),
    ).toBeNull();
  });
});

const link = (number: number, source: ThreadPullRequestLink["source"] = "manual") =>
  ({
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source,
    linkedAt: "2026-08-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
  }) satisfies ThreadPullRequestLink;

const shell = (
  id: string,
  overrides: Partial<Parameters<typeof reviewSourceCandidates>[0]["threads"][number]> = {},
) => ({
  id: ThreadId.make(id),
  pullRequests: [link(7)],
  archivedAt: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

describe("reviewSourceCandidates", () => {
  it("reads the other unarchived threads linked to the same pull request, newest first", () => {
    const candidates = reviewSourceCandidates({
      threadId: ThreadId.make("work"),
      pullRequests: [PR_7],
      threads: [
        shell("work"),
        shell("older", { updatedAt: "2026-08-02T00:00:00.000Z" }),
        shell("newer", { updatedAt: "2026-08-04T00:00:00.000Z" }),
        shell("other-pr", { pullRequests: [link(8)] }),
        shell("archived", { archivedAt: "2026-08-05T00:00:00.000Z" }),
        shell("dismissed", { pullRequests: [link(7, "stack-dismissed")] }),
      ],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["newer", "older"]);
  });

  it("reads nothing for a thread without a pull request", () => {
    expect(
      reviewSourceCandidates({
        threadId: ThreadId.make("work"),
        pullRequests: [],
        threads: [shell("a")],
      }),
    ).toEqual([]);
  });
});

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
