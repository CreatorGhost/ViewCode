import {
  EventId,
  ProjectId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type ReviewFindingsTarget,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { AGENT_MESSAGE_SENT_ACTIVITY_KIND } from "@t3tools/shared/agentMessages";

import {
  groupReviewFindingsBySeverity,
  mergeReviewFindingRatings,
  openReviewFindingCount,
  reviewFindingEntries,
  reviewFindingIdentity,
  reviewFindingMarksByKey,
  reviewFindingsInFileOrder,
  reviewFixAllInitiallyTicked,
  reviewFixAllMode,
  reviewIssueOrder,
  reviewFixCandidates,
  selectReviewFixChat,
  reviewFixUndo,
  reviewHeadMoved,
  reviewPostAllWaits,
  reviewPostOverallComment,
  reviewRereviewBasis,
  reviewRereviewSummary,
  reviewProgress,
  reviewRunState,
  reviewSourceCandidates,
  reviewTurnInFlight,
  selectLatestReview,
  selectPullRequestReviewFindings,
  selectReviewFindingsSource,
  startedReviewThreadIds,
  threadReviewCandidates,
  unsettledReviewFindingRatings,
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

  it("shows the newest review a child agent of the thread made, whatever it reviewed", () => {
    const child = (id: string, activities: ReadonlyArray<Activity>) => ({
      ...thread(id, activities),
      child: true,
    });
    const source = selectReviewFindingsSource({
      thread: thread("work", []),
      pullRequests: [PR_7],
      linkedThreads: [
        child("old-local", [
          findingsActivity("old", "2026-08-01T00:00:00.000Z", { kind: "local" }),
        ]),
        child("new-local", [
          findingsActivity("new", "2026-08-03T00:00:00.000Z", { kind: "local" }),
        ]),
        // A linked thread's review of another pull request still does not count.
        thread("stack-review", [
          findingsActivity("stack", "2026-08-05T00:00:00.000Z", prTarget(8)),
        ]),
      ],
    });
    expect(source).toMatchObject({ threadId: "new-local", activityId: "new" });
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

const turn = (
  state: "running" | "completed" | "error" | "interrupted",
  completedAt: string | null = null,
) => ({
  turnId: TurnId.make("turn-1"),
  state,
  requestedAt: "2026-08-01T00:00:00.000Z",
  startedAt: null,
  completedAt,
  assistantMessageId: null,
});
const session = (
  status: "ready" | "running" | "error" | "interrupted",
  lastError: string | null = null,
) => ({
  threadId: ThreadId.make("review"),
  status,
  providerName: null,
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError,
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("reviewRunState", () => {
  it("counts a review as running from the moment its first turn is asked for", () => {
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

  it("keeps a reviewer waiting on its agents running, until the whole tree is idle", () => {
    const id = (value: string) => ThreadId.make(value);
    const lead = {
      id: id("lead"),
      session: session("ready"),
      latestTurn: turn("completed", "T10"),
    };
    const lens = (state: "running" | "completed", completedAt: string | null = null) => ({
      id: id("lens"),
      session: session(state === "running" ? "running" : "ready"),
      latestTurn: turn(state, completedAt),
    });
    expect(reviewRunState(lead, [lens("running")])).toEqual({ kind: "running" });
    // An answer queued for a busy or paused reviewer is still work to do.
    expect(
      reviewRunState(lead, [lens("completed", "T11")], (thread) => (thread === "lead" ? 1 : 0)),
    ).toEqual({ kind: "running" });
    // A lens that finished after the reviewer's last turn and sent nothing back does not keep the
    // review running forever.
    expect(reviewRunState(lead, [lens("completed", "T11")])).toEqual({ kind: "ended" });
  });

  it("says a review failed with the provider's error, and ended otherwise", () => {
    const id = ThreadId.make("review");
    expect(
      reviewRunState(
        { id, session: session("error", "Quota exceeded"), latestTurn: turn("error", "T10") },
        [],
      ),
    ).toEqual({ kind: "failed", error: "Quota exceeded" });
    expect(
      reviewRunState({ id, session: session("ready"), latestTurn: turn("error") }, []),
    ).toEqual({ kind: "failed", error: null });
    // Stopped by the reader.
    expect(
      reviewRunState({ id, session: session("interrupted"), latestTurn: turn("interrupted") }, []),
    ).toEqual({ kind: "ended" });
  });
});

describe("reviewProgress", () => {
  const partial = { complete: false };
  it("is done only once the final findings are in", () => {
    expect(reviewProgress({ run: { kind: "running" }, findings: {} })).toEqual({ kind: "done" });
    expect(reviewProgress({ run: { kind: "ended" }, findings: { complete: true } })).toEqual({
      kind: "done",
    });
    // A reviewer whose session errored after its final findings (a server restart) is done.
    expect(
      reviewProgress({
        run: { kind: "failed", error: "Provider session did not survive a server restart." },
        findings: { complete: true },
      }),
    ).toEqual({ kind: "done" });
    expect(reviewProgress({ run: { kind: "running" }, findings: partial })).toEqual({
      kind: "running",
      partial: true,
    });
    expect(reviewProgress({ run: { kind: "running" }, findings: null })).toEqual({
      kind: "running",
      partial: false,
    });
  });

  it("says a review stopped without its final findings, keeping those sent so far", () => {
    expect(reviewProgress({ run: { kind: "ended" }, findings: null })).toEqual({
      kind: "ended",
      partial: false,
    });
    expect(reviewProgress({ run: { kind: "ended" }, findings: partial })).toEqual({
      kind: "ended",
      partial: true,
    });
    expect(
      reviewProgress({ run: { kind: "failed", error: "Quota exceeded" }, findings: partial }),
    ).toEqual({ kind: "failed", error: "Quota exceeded", partial: true });
  });
});

describe("selectLatestReview", () => {
  const started = (payload: object) => ({
    id: EventId.make(`started-${JSON.stringify(payload)}`),
    kind: REVIEW_STARTED_ACTIVITY_KIND,
    createdAt: "2026-08-01T00:00:00.000Z",
    payload: { ...payload, timelineBypass: true },
  });
  const candidate = (
    id: string,
    activities: ReadonlyArray<Activity>,
    createdAt: string,
    run: { kind: "running" } | { kind: "ended" } = { kind: "running" },
  ) => ({ ...thread(id, activities), createdAt, run });

  it("finds the newest review by its start record, whatever its thread is called", () => {
    const latest = selectLatestReview([
      candidate("quick", [started({ mode: "quick" })], "2026-08-01T00:00:00.000Z"),
      candidate("deep", [started({ mode: "deep", focus: "retries" })], "2026-08-02T00:00:00.000Z", {
        kind: "ended",
      }),
      // Not a review: no start record, however it is titled.
      { ...candidate("chat", [], "2026-08-03T00:00:00.000Z"), title: "Deep review: #7 Fix" },
    ]);
    expect(latest).toMatchObject({
      thread: { id: "deep" },
      mode: "deep",
      focus: "retries",
      progress: { kind: "ended", partial: false },
    });
  });

  it("reads a review's findings sent so far, and its final ones as done", () => {
    const partial = findingsActivity("partial", "2026-08-02T00:00:00.000Z");
    const latest = (complete: boolean | undefined) =>
      selectLatestReview([
        candidate(
          "deep",
          [started({ mode: "deep" }), { ...partial, payload: { ...partial.payload, complete } }],
          "2026-08-02T00:00:00.000Z",
        ),
      ])?.progress;
    expect(latest(false)).toEqual({ kind: "running", partial: true });
    expect(latest(true)).toEqual({ kind: "done" });
    // Findings from before the flag were always the final set.
    expect(latest(undefined)).toEqual({ kind: "done" });
  });

  it("says a review failed when its reviewer errored, even if later turns completed", () => {
    const error = (message: string) => ({
      id: EventId.make(`error-${message}`),
      kind: "runtime.error",
      createdAt: "2026-08-02T00:05:00.000Z",
      payload: { message },
    });
    const progress = (activities: ReadonlyArray<Activity>, run = { kind: "ended" } as const) =>
      selectLatestReview([candidate("deep", activities, "2026-08-02T00:00:00.000Z", run)])
        ?.progress;
    // The lead failed, then its lenses' answers woke it into turns that completed.
    expect(progress([started({ mode: "deep" }), error("Quota exceeded")])).toEqual({
      kind: "failed",
      error: "Quota exceeded",
      partial: false,
    });
    // An error before this review started belongs to an earlier one.
    expect(progress([error("Old failure"), started({ mode: "deep" })])).toEqual({
      kind: "ended",
      partial: false,
    });
    // Final findings, or a review still at work, outrank an error on the way.
    expect(
      progress([started({ mode: "deep" }), error("Blip")], { kind: "running" } as never),
    ).toEqual({ kind: "running", partial: false });
  });

  it("reads a review started before the mode was recorded as a quick one", () => {
    expect(
      selectLatestReview([candidate("old", [started({})], "2026-08-01T00:00:00.000Z")])?.mode,
    ).toBe("quick");
    expect(selectLatestReview([candidate("chat", [], "2026-08-01T00:00:00.000Z")])).toBeNull();
  });
});

describe("reviewFindingMarksByKey", () => {
  it("keeps the reader's marks on a finding when the review's next set moves it", () => {
    const finding = (title: string, line: number) => ({
      severity: "nit" as const,
      confidence: 80,
      path: "a.ts",
      line,
      title,
      detail: "Detail.",
    });
    const partial = reviewFindingEntries({
      findings: [finding("Stale label", 4)],
      needsChecking: [],
    });
    const marks = { [reviewFindingIdentity(partial[0]!.finding)]: true as const };
    const final = reviewFindingEntries({
      findings: [finding("Missing guard", 1), finding("Stale  label", 4)],
      needsChecking: [],
    });
    expect(reviewFindingMarksByKey(final, marks)).toEqual({ "finding:1": true });
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
  overrides: Partial<Parameters<typeof threadReviewCandidates>[0]["threads"][number]> = {},
) => ({
  id: ThreadId.make(id),
  parentThreadId: null,
  kind: null,
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

describe("threadReviewCandidates", () => {
  it("reads the thread itself, then its child agents, then the threads linked to its pull request", () => {
    const work = ThreadId.make("work");
    const candidates = threadReviewCandidates({
      threadId: work,
      pullRequests: [PR_7],
      threads: [
        shell("linked", { updatedAt: "2026-08-05T00:00:00.000Z" }),
        shell("work", { pullRequests: [link(7)] }),
        shell("review", { parentThreadId: work, pullRequests: [link(7)] }),
        shell("agent", {
          parentThreadId: work,
          pullRequests: [],
          updatedAt: "2026-08-02T00:00:00.000Z",
        }),
        // A side chat is no agent of its parent, and an archived child is not read.
        shell("side", { parentThreadId: work, kind: "sidechat", pullRequests: [] }),
        shell("gone", {
          parentThreadId: work,
          pullRequests: [],
          archivedAt: "2026-08-05T00:00:00.000Z",
        }),
      ],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "work",
      "agent",
      "review",
      "linked",
    ]);
  });
});

describe("startedReviewThreadIds", () => {
  const sent = (toThreadId: string, review?: string) => ({
    kind: AGENT_MESSAGE_SENT_ACTIVITY_KIND,
    payload: {
      messageId: `m-${toThreadId}`,
      toThreadId,
      toName: toThreadId,
      body: "Look at it.",
      replyExpected: true,
      inReplyTo: null,
      kind: "spawn",
      delivery: "started",
      ...(review ? { review } : {}),
    },
  });

  it("lists the reviews a chat started, newest first, and none of its other agents", () => {
    expect(
      startedReviewThreadIds([sent("review-1", "deep"), sent("helper"), sent("review-2", "quick")]),
    ).toEqual(["review-2", "review-1"]);
  });

  it("keeps an earlier review among the threads read after the chat starts many agents", () => {
    const work = ThreadId.make("work");
    const helpers = ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      shell(id, {
        parentThreadId: work,
        pullRequests: [],
        updatedAt: `2026-08-0${index + 2}T00:00:00.000Z`,
      }),
    );
    const candidates = threadReviewCandidates({
      threadId: work,
      pullRequests: [],
      threads: [
        shell("work", { pullRequests: [] }),
        shell("review-1", {
          parentThreadId: work,
          pullRequests: [],
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
        ...helpers,
      ],
      reviewThreadIds: [ThreadId.make("review-1")],
    });
    expect(candidates.map((candidate) => candidate.id)).toContain("review-1");
    expect(candidates[1]?.id).toBe("review-1");
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
        // A reviewer's lens agent works on the pull request too, but is no chat to fix in.
        fixThread("lens", {
          pullRequests: [fixLink(7)],
          parentThreadId: ThreadId.make("review"),
          updatedAt: "2026-08-07T00:00:00.000Z",
        }),
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

describe("selectReviewFixChat", () => {
  const chat = ThreadId.make("chat");
  const reviewer = fixThread("review", { parentThreadId: chat });

  it("always picks the chat the review was started from", () => {
    const choice = selectReviewFixChat({
      reviewThreadId: reviewer.id,
      projectId: PROJECT_ID,
      target: PR_TARGET,
      threads: [
        reviewer,
        fixThread("chat"),
        // Busier chats on the pull request do not take it over.
        fixThread("other", {
          pullRequests: [fixLink(7)],
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      ],
    });
    expect(choice).toMatchObject({ kind: "thread", thread: { id: "chat" } });
  });

  it("without a parent, picks the chat working on the change, never one of the reviewer's agents", () => {
    const topLevel = fixThread("review");
    const choice = selectReviewFixChat({
      reviewThreadId: topLevel.id,
      projectId: PROJECT_ID,
      target: PR_TARGET,
      threads: [
        topLevel,
        fixThread("lens", {
          parentThreadId: topLevel.id,
          pullRequests: [fixLink(7)],
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
        fixThread("author", { pullRequests: [fixLink(7)] }),
      ],
    });
    expect(choice).toMatchObject({ kind: "thread", thread: { id: "author" } });
  });

  it("opens a new chat on a local review's checkout when no chat works on it", () => {
    const local = fixThread("review", { branch: "feature", worktreePath: "/w/f" });
    expect(
      selectReviewFixChat({
        reviewThreadId: local.id,
        projectId: null,
        target: { kind: "local" },
        threads: [local],
      }),
    ).toEqual({ kind: "new", projectId: PROJECT_ID, branch: "feature", worktreePath: "/w/f" });
  });
});

describe("reviewRereviewBasis", () => {
  const source = (target: ReviewFindingsTarget, headSha?: string) => {
    const activity = findingsActivity("found", "2026-08-01T00:00:00.000Z", target);
    return selectReviewFindingsSource({
      thread: thread("review", [
        { ...activity, payload: { ...activity.payload, ...(headSha ? { headSha } : {}) } },
      ]),
      pullRequests: [],
      linkedThreads: [],
    })!;
  };

  it("re-reviews only what changed when the review named its commit", () => {
    expect(
      reviewRereviewBasis(source(prTarget(7), "abc1234"), {
        kind: "pull-request",
        reference: PR_7,
      }),
    ).toEqual({
      basedOn: { threadId: ThreadId.make("review"), activityId: EventId.make("found") },
      onlyChanges: true,
    });
  });

  it("re-reviews the whole change when no commit is known, as for local changes", () => {
    expect(reviewRereviewBasis(source({ kind: "local" }), { kind: "local" })?.onlyChanges).toBe(
      false,
    );
    expect(
      reviewRereviewBasis(source(prTarget(7)), {
        kind: "pull-request",
        // The project's own host, when the reference names none.
        reference: { repository: "t3tools/t3code", number: 7 },
      })?.onlyChanges,
    ).toBe(false);
  });

  it("offers nothing for a review of something else", () => {
    expect(
      reviewRereviewBasis(source(prTarget(8), "abc1234"), {
        kind: "pull-request",
        reference: PR_7,
      }),
    ).toBeNull();
    expect(reviewRereviewBasis(source(prTarget(7)), { kind: "local" })).toBeNull();
  });
});

describe("finding ratings", () => {
  const server = new Map([
    ["finding:0", "up"],
    ["finding:1", "down"],
  ] as const);

  it("shows the reader's clicks over the server's ratings, a null taking one back", () => {
    const merged = mergeReviewFindingRatings(
      server,
      new Map([
        ["finding:0", null],
        ["check:0", "down"],
      ] as const),
    );
    expect([...merged]).toEqual([
      ["finding:1", "down"],
      ["check:0", "down"],
    ]);
    expect(mergeReviewFindingRatings(server, new Map())).toBe(server);
  });

  it("keeps a click only until the server says the same, so later changes elsewhere show", () => {
    const pending = new Map<string, "up" | "down" | null>([
      ["finding:0", "up"],
      ["finding:1", null],
      ["check:0", null],
    ]);
    // The server recorded the thumbs up and has no rating for check:0; finding:1 is still down.
    expect([...unsettledReviewFindingRatings(server, pending)]).toEqual([["finding:1", null]]);
    const unchanged = new Map([["finding:1", null]] as const);
    expect(unsettledReviewFindingRatings(server, unchanged)).toBe(unchanged);
  });
});

describe("reviewHeadMoved", () => {
  it("compares the reviewed commit with the current head, abbreviated or not", () => {
    expect(reviewHeadMoved("abc1234", "def5678")).toBe(true);
    expect(reviewHeadMoved("ABC1234", "abc1234f00d")).toBe(false);
    expect(reviewHeadMoved("abc1234f00d", "abc1234")).toBe(false);
    expect(reviewHeadMoved(undefined, "abc1234")).toBe(false);
    expect(reviewHeadMoved("abc1234", undefined)).toBe(false);
  });
});

describe("reviewRereviewSummary", () => {
  it("says how the earlier findings fared on a re-review", () => {
    expect(reviewRereviewSummary({ incremental: true, previous: { fixed: 2, stillOpen: 1 } })).toBe(
      "Re-review · 2 fixed · 1 still open",
    );
    expect(reviewRereviewSummary({ incremental: true })).toBe("Re-review");
    expect(reviewRereviewSummary({})).toBeNull();
  });
});

describe("reviewFixUndo", () => {
  const fixStarted = {
    kind: REVIEW_FIX_STARTED_ACTIVITY_KIND,
    payload: { reviewThreadId: "review", turnCountBefore: 0, timelineBypass: true },
  };
  const checkpoints = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ checkpointTurnCount: index + 1 }));

  it("takes back every turn since the fix started", () => {
    expect(reviewFixUndo({ activities: [fixStarted], checkpoints: checkpoints(3) })).toEqual({
      turnCount: 0,
      undoneTurns: 3,
    });
    expect(reviewFixUndo({ activities: [fixStarted], checkpoints: [] })).toEqual({
      turnCount: 0,
      undoneTurns: 0,
    });
  });

  it("offers nothing on a session not started to fix findings", () => {
    expect(
      reviewFixUndo({ activities: [{ kind: "tool.completed", payload: {} }], checkpoints: [] }),
    ).toBeNull();
    expect(
      reviewFixUndo({
        activities: [{ kind: REVIEW_FIX_STARTED_ACTIVITY_KIND, payload: {} }],
        checkpoints: checkpoints(1),
      }),
    ).toBeNull();
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

  it("puts findings no diff places in file order, path then line", () => {
    const at = (key: string, path: string, line?: number) => ({
      key,
      finding: { severity: "important", path, line, title: key },
    });
    expect(
      reviewFindingsInFileOrder([at("c", "b.ts", 3), at("a", "a.ts", 9), at("b", "b.ts")]).map(
        (entry) => entry.key,
      ),
    ).toEqual(["a", "b", "c"]);
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
