import {
  EventId,
  ProjectId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type ReviewFindingsTarget,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  groupReviewFindingsBySeverity,
  openReviewFindingCount,
  reviewFindingEntries,
  reviewFixCandidates,
  reviewPostOverallComment,
  reviewSourceCandidates,
  reviewThreadMode,
  reviewTurnInFlight,
  selectPullRequestReviewFindings,
  selectReviewFindingsSource,
  selectRunningPullRequestReview,
} from "./reviewFindings.ts";

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

describe("selectPullRequestReviewFindings", () => {
  it("shows the newest review of the pull request with no thread of its own to prefer", () => {
    const source = selectPullRequestReviewFindings({
      pullRequests: [PR_7],
      threads: [
        thread("old-review", [findingsActivity("old", "2026-08-01T00:00:00.000Z")]),
        // A re-review in the same thread replaces its earlier set.
        thread("re-review", [
          findingsActivity("first", "2026-08-02T00:00:00.000Z"),
          findingsActivity("second", "2026-08-04T00:00:00.000Z"),
        ]),
        thread("stack-review", [
          findingsActivity("stack", "2026-08-05T00:00:00.000Z", prTarget(8)),
        ]),
        thread("work", [otherActivity("tool", "2026-08-06T00:00:00.000Z")]),
      ],
    });
    expect(source).toMatchObject({ threadId: "re-review", activityId: "second" });
  });

  it("shows nothing for a pull request nobody reviewed", () => {
    expect(
      selectPullRequestReviewFindings({
        pullRequests: [PR_7],
        threads: [
          thread("stack-review", [
            findingsActivity("stack", "2026-08-05T00:00:00.000Z", prTarget(8)),
          ]),
        ],
      }),
    ).toBeNull();
  });
});

describe("selectRunningPullRequestReview", () => {
  const candidate = (
    id: string,
    title: string,
    running: boolean,
    activities: ReadonlyArray<Activity> = [],
    createdAt = "2026-08-01T00:00:00.000Z",
  ) => ({ ...thread(id, activities), title, running, createdAt });

  it("finds the newest review thread of the pull request still working on its findings", () => {
    const running = selectRunningPullRequestReview({
      number: 7,
      threads: [
        candidate("quick", "Review: #7 Fix the cache", true),
        candidate("deep", "Deep review: #7 Fix the cache", true, [], "2026-08-02T00:00:00.000Z"),
        // Not reviews of this pull request, or not running, or already done.
        candidate("work", "Fix the cache", true, [], "2026-08-03T00:00:00.000Z"),
        candidate("layer", "Review: #70 Other", true, [], "2026-08-03T00:00:00.000Z"),
        candidate("idle", "Security audit: #7 Fix", false, [], "2026-08-03T00:00:00.000Z"),
        candidate(
          "done",
          "Security audit: #7 Fix",
          true,
          [findingsActivity("found", "2026-08-03T00:00:00.000Z")],
          "2026-08-03T00:00:00.000Z",
        ),
      ],
    });
    expect(running?.thread.id).toBe("deep");
    expect(running?.mode).toBe("deep");
  });

  it("counts a review as running from the moment its first turn is asked for", () => {
    const turn = (state: "running" | "completed") => ({
      turnId: TurnId.make("turn-1"),
      state,
      requestedAt: "2026-08-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    });
    const session = (status: "ready" | "running" | "error") => ({
      threadId: ThreadId.make("review"),
      status,
      providerName: null,
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    // Not yet adopted by a session.
    expect(reviewTurnInFlight({ session: null, latestTurn: null })).toBe(true);
    expect(reviewTurnInFlight({ session: session("running"), latestTurn: null })).toBe(true);
    expect(reviewTurnInFlight({ session: session("ready"), latestTurn: turn("running") })).toBe(
      true,
    );
    expect(reviewTurnInFlight({ session: session("ready"), latestTurn: turn("completed") })).toBe(
      false,
    );
    expect(reviewTurnInFlight({ session: session("error"), latestTurn: null })).toBe(false);
  });

  it("reads each mode from the title the server gives a review", () => {
    expect(reviewThreadMode("Review: #7 Fix", 7)).toBe("quick");
    expect(reviewThreadMode("Security audit: #7 Fix", 7)).toBe("security");
    expect(reviewThreadMode("Review: #7", 7)).toBeNull();
    expect(reviewThreadMode("Code review: #7 Fix", 7)).toBeNull();
  });
});

describe("groupReviewFindingsBySeverity", () => {
  const finding = (title: string, severity: "blocker" | "important" | "nit" | "question") => ({
    severity,
    confidence: 80,
    path: "a.ts",
    title,
    detail: "Detail.",
  });

  it("groups the most severe first, settled findings before unsettled ones, empty groups left out", () => {
    const groups = groupReviewFindingsBySeverity(
      reviewFindingEntries({
        findings: [finding("Nit", "nit"), finding("Blocker", "blocker")],
        needsChecking: [finding("Unsettled blocker", "blocker"), finding("Ask", "question")],
      }),
    );
    expect(
      groups.map((group) => [group.severity, group.entries.map((entry) => entry.key)]),
    ).toEqual([
      ["blocker", ["finding:1", "check:0"]],
      ["nit", ["finding:0"]],
      ["question", ["check:1"]],
    ]);
  });
});

describe("openReviewFindingCount", () => {
  const findings = {
    findings: [
      { severity: "nit" as const, confidence: 70, path: "a.ts", title: "A", detail: "A." },
      { severity: "nit" as const, confidence: 70, path: "b.ts", title: "B", detail: "B." },
    ],
    needsChecking: [
      { severity: "question" as const, confidence: 40, path: "c.ts", title: "C", detail: "C." },
    ],
  };

  it("counts the findings neither dismissed nor posted", () => {
    expect(openReviewFindingCount(findings, {}, new Map())).toBe(3);
    expect(
      openReviewFindingCount(
        findings,
        { "finding:0": true },
        new Map([["check:0", { placement: "inline", url: "https://x", verdict: "comment" }]]),
      ),
    ).toBe(1);
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

  it("reads every linked thread for the pull request page, which is no thread", () => {
    const candidates = reviewSourceCandidates({
      threadId: null,
      pullRequests: [PR_7],
      threads: [shell("work"), shell("other-pr", { pullRequests: [link(8)] })],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["work"]);
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

describe("reviewPostOverallComment", () => {
  const entry = (title: string, severity: "blocker" | "important" | "nit", check = false) => ({
    key: check ? ("check:0" as const) : ("finding:0" as const),
    needsChecking: check,
    finding: { severity, confidence: 80, path: "a.ts", title, detail: "Detail." },
  });

  it("starts from the verdict and the two most severe settled findings", () => {
    expect(
      reviewPostOverallComment("request-changes", [
        entry("A nit", "nit"),
        entry("Unsettled blocker", "blocker", true),
        entry("Important one", "important"),
        entry("A blocker", "blocker"),
      ]),
    ).toBe("Request changes.\n\n- A blocker\n- Important one");
    expect(reviewPostOverallComment("approve", [])).toBe("Approve.");
  });
});

const PROJECT_ID = ProjectId.make("project-1");
const PR_TARGET = {
  kind: "pull-request",
  host: "github.com",
  repository: "t3tools/t3code",
  number: 7,
  url: "https://github.com/t3tools/t3code/pull/7",
} as const;

const fixLink = (number: number, source: ThreadPullRequestLink["source"] = "manual") =>
  ({
    host: "github.com",
    repository: "T3Tools/T3Code",
    number,
    url: `https://github.com/T3Tools/T3Code/pull/${number}`,
    source,
    linkedAt: "2026-08-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
  }) satisfies ThreadPullRequestLink;

const fixThread = (
  id: string,
  overrides: Partial<Parameters<typeof reviewFixCandidates>[0]["threads"][number]> = {},
) => ({
  id: ThreadId.make(id),
  projectId: PROJECT_ID,
  branch: null,
  worktreePath: null,
  pullRequests: [],
  archivedAt: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const review = fixThread("review", { pullRequests: [fixLink(7)] });

describe("reviewFixCandidates", () => {
  it("offers the threads linked to the reviewed pull request, newest first, never the review", () => {
    const result = reviewFixCandidates({
      reviewThread: review,
      target: PR_TARGET,
      threads: [
        review,
        fixThread("older", { pullRequests: [fixLink(7)], updatedAt: "2026-08-02T00:00:00.000Z" }),
        fixThread("other-pr", { pullRequests: [fixLink(8)] }),
        fixThread("newer", { pullRequests: [fixLink(7)], updatedAt: "2026-08-05T00:00:00.000Z" }),
        fixThread("archived", {
          pullRequests: [fixLink(7)],
          archivedAt: "2026-08-06T00:00:00.000Z",
        }),
        fixThread("dismissed", { pullRequests: [fixLink(7, "stack-dismissed")] }),
      ],
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["newer", "older"]);
    expect(result.preselectedId).toBeNull();
  });

  it("preselects the only session working on the pull request", () => {
    const result = reviewFixCandidates({
      reviewThread: review,
      target: PR_TARGET,
      threads: [review, fixThread("author", { pullRequests: [fixLink(7)] })],
    });
    expect(result.preselectedId).toBe("author");
  });

  it("offers the threads on a local review's own checkout", () => {
    const localReview = fixThread("review", { branch: "feature", worktreePath: "/w/feature" });
    const result = reviewFixCandidates({
      reviewThread: localReview,
      target: { kind: "local" },
      threads: [
        localReview,
        fixThread("same", { branch: "feature", worktreePath: "/w/feature" }),
        fixThread("main", { branch: "main", worktreePath: null }),
        fixThread("elsewhere", {
          projectId: ProjectId.make("project-2"),
          branch: "feature",
          worktreePath: "/w/feature",
        }),
      ],
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["same"]);
    expect(result.preselectedId).toBe("same");
  });

  it("has nothing to preselect when no session works on the change", () => {
    expect(
      reviewFixCandidates({ reviewThread: review, target: PR_TARGET, threads: [review] }),
    ).toEqual({ candidates: [], preselectedId: null });
  });
});
