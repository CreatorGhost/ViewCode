import type {
  OrchestrationCommand,
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestLink,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PULL_REQUEST_WATCH_WAKE_LIMIT,
  decidePullRequestWatch,
  evaluatePullRequestWatch,
  freshPullRequestWatch,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

const START = "2026-08-20T00:00:00.000Z";

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});

const remark = (id: string, login: string, createdAt: string): PullRequestComment => ({
  id,
  kind: "issue-comment",
  author: { login, avatarUrl: null } as PullRequestComment["author"],
  body: `comment ${id}`,
  createdAt,
  url: null,
  path: null,
  reviewState: null,
});

const detail = (
  input: Partial<{
    headSha: string;
    checks: ReadonlyArray<PullRequestCheck>;
    mergeability: "mergeable" | "conflicting" | "unknown";
  }> = {},
) => ({
  headSha: input.headSha ?? "aaaaaaa1",
  checks: input.checks ?? [],
  mergeability: input.mergeability ?? "mergeable",
  viewer: "agent-bot",
  author: null,
});

/** The watch after one quiet first pass on head aaaaaaa1. */
const settled = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  ...freshPullRequestWatch(START),
  headSha: "aaaaaaa1",
  ...overrides,
});

describe("evaluatePullRequestWatch", () => {
  it("reports a failed check once, and again when a rerun fails", () => {
    const failed = evaluatePullRequestWatch(
      settled(),
      detail({ checks: [check("test", "failure"), check("lint", "pending")] }),
      [],
    );
    expect(failed.changes).toMatchObject([{ kind: "checks-failed", failed: [{ name: "test" }] }]);

    // Same state on the next pass: nothing new.
    expect(
      evaluatePullRequestWatch(
        failed.next,
        detail({ checks: [check("test", "failure"), check("lint", "pending")] }),
        [],
      ).changes,
    ).toEqual([]);

    // The rerun leaves the failed list while it runs, so its second failure is news.
    const rerun = evaluatePullRequestWatch(
      failed.next,
      detail({ checks: [check("test", "pending"), check("lint", "success")] }),
      [],
    );
    expect(rerun.changes).toEqual([]);
    expect(
      evaluatePullRequestWatch(
        rerun.next,
        detail({ checks: [check("test", "failure"), check("lint", "success")] }),
        [],
      ).changes,
    ).toMatchObject([{ kind: "checks-failed" }]);
  });

  it("reports green once every check finished, and again after a push", () => {
    const green = evaluatePullRequestWatch(
      settled(),
      detail({ checks: [check("test", "success"), check("lint", "skipped")] }),
      [],
    );
    expect(green.changes).toEqual([{ kind: "checks-passed", count: 2 }]);
    expect(
      evaluatePullRequestWatch(green.next, detail({ checks: [check("test", "success")] }), [])
        .changes,
    ).toEqual([]);
    // A new head commit starts over.
    expect(
      evaluatePullRequestWatch(
        green.next,
        detail({ headSha: "bbbbbbb2", checks: [check("test", "success")] }),
        [],
      ).changes,
    ).toEqual([{ kind: "checks-passed", count: 1 }]);
  });

  it("keeps the last check state when the host answers with no checks", () => {
    const watch = settled({ failedChecks: ["test"], passed: false });
    const report = evaluatePullRequestWatch(watch, detail({ checks: [] }), []);
    expect(report.changes).toEqual([]);
    expect(report.next.failedChecks).toEqual(["test"]);
  });

  it("wakes on other people's comments only, telling same-second remarks apart by id", () => {
    const at = "2026-08-20T00:05:00.000Z";
    const first = evaluatePullRequestWatch(settled(), detail(), [
      remark("1", "agent-bot", at),
      remark("2", "reviewer", at),
      remark("0", "reviewer", "2026-08-19T23:59:00.000Z"),
    ]);
    expect(first.changes).toMatchObject([{ kind: "remarks", remarks: [{ id: "2" }] }]);
    expect(first.next).toMatchObject({ remarksThrough: at, remarkIds: ["2"], wakes: 1 });

    // A remark stamped the same second but read later is still news; the told one is not.
    const late = evaluatePullRequestWatch(first.next, detail(), [
      remark("2", "reviewer", at),
      remark("3", "reviewer", at),
    ]);
    expect(late.changes).toMatchObject([{ kind: "remarks", remarks: [{ id: "3" }] }]);
    expect(late.next.remarkIds).toEqual(["2", "3"]);
  });

  it("holds remarks when the conversation could not be read whole", () => {
    const report = evaluatePullRequestWatch(settled(), detail(), null);
    expect(report.changes).toEqual([]);
    expect(report.next.remarksThrough).toBe(START);
  });

  it("reports a new conflict once and keeps it through an unknown answer", () => {
    const conflict = evaluatePullRequestWatch(
      settled(),
      detail({ mergeability: "conflicting" }),
      [],
    );
    expect(conflict.changes).toEqual([{ kind: "conflicting" }]);
    const computing = evaluatePullRequestWatch(
      conflict.next,
      detail({ mergeability: "unknown" }),
      [],
    );
    expect(computing.changes).toEqual([]);
    expect(computing.next.conflicting).toBe(true);
    const clean = evaluatePullRequestWatch(computing.next, detail(), []);
    expect(clean.next.conflicting).toBe(false);
  });

  it("stops after too many comment-only wakes, and any other news resets the count", () => {
    const almost = settled({ wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const chatty = evaluatePullRequestWatch(almost, detail(), [
      remark("9", "bot", "2026-08-20T01:00:00.000Z"),
    ]);
    expect(chatty.exhausted).toBe(true);

    const mixed = evaluatePullRequestWatch(almost, detail({ checks: [check("test", "failure")] }), [
      remark("9", "bot", "2026-08-20T01:00:00.000Z"),
    ]);
    expect(mixed.exhausted).toBe(false);
    expect(mixed.next.wakes).toBe(0);
  });

  it("writes a message the agent can act on", () => {
    const report = evaluatePullRequestWatch(
      settled(),
      detail({ checks: [check("test", "failure")], mergeability: "conflicting" }),
      [],
    );
    const text = pullRequestWatchMessage({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      baseBranch: "main",
      headSha: report.next.headSha,
      report,
    });
    expect(text).toContain("Update on pull request #7 (https://github.com/o/r/pull/7)");
    expect(text).toContain("- Checks failed on aaaaaaa:");
    expect(text).toContain("- The branch now conflicts with main.");
    expect(text).toContain("call unwatch_pull_request first");
  });
});

describe("decidePullRequestWatch", () => {
  const link = (overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink => ({
    host: "github.com",
    repository: "o/r",
    number: 7,
    url: "https://github.com/o/r/pull/7",
    source: "agent",
    linkedAt: START,
    snapshot: null,
    stack: null,
    ...overrides,
  });
  const thread = (
    pullRequests: ReadonlyArray<ThreadPullRequestLink>,
    settledAt: string | null = null,
  ) => ({
    pullRequests,
    archivedAt: null,
    settledOverride: null,
    settledAt,
  });
  const watchCommand = (
    watching: boolean,
    extra: Partial<Extract<OrchestrationCommand, { type: "thread.pull-request.watch" }>> = {},
  ) =>
    ({
      type: "thread.pull-request.watch",
      commandId: "c",
      threadId: "t",
      host: "github.com",
      repository: "o/r",
      number: 7,
      watching,
      ...extra,
    }) as Extract<OrchestrationCommand, { type: "thread.pull-request.watch" }>;
  const NOW = "2026-08-21T00:00:00.000Z";

  it("links an unlinked pull request while starting to watch it", () => {
    const decided = decidePullRequestWatch(
      thread([]),
      watchCommand(true, { link: { url: "https://github.com/o/r/pull/7", source: "agent" } }),
      NOW,
    );
    expect(decided).toMatchObject({
      link: { number: 7, linkedAt: NOW, watch: { startedAt: NOW, remarksThrough: NOW } },
    });
  });

  it("refuses closed pull requests, settled threads and repeats", () => {
    const merged = link({
      snapshot: { state: "merged" } as ThreadPullRequestLink["snapshot"],
    });
    expect(decidePullRequestWatch(thread([merged]), watchCommand(true), NOW)).toEqual({
      rejected: "the pull request is merged",
    });
    expect(decidePullRequestWatch(thread([link()], NOW), watchCommand(true), NOW)).toMatchObject({
      rejected: expect.stringContaining("settled"),
    });
    const watched = link({ watch: freshPullRequestWatch(START) });
    expect(decidePullRequestWatch(thread([watched]), watchCommand(true), NOW)).toMatchObject({
      rejected: "the pull request is already watched",
    });
    expect(decidePullRequestWatch(thread([watched]), watchCommand(false), NOW)).toEqual({
      link: link(),
    });
  });

  it("applies a pass only to the watch it read, so a stop or restart wins", () => {
    const watched = link({ watch: freshPullRequestWatch(START) });
    const sync = (startedAt: string, watch: ThreadPullRequestWatch | null) =>
      ({
        type: "thread.pull-request-watch.sync",
        commandId: "c",
        threadId: "t",
        host: "github.com",
        repository: "o/r",
        number: 7,
        startedAt,
        watch,
      }) as Extract<OrchestrationCommand, { type: "thread.pull-request-watch.sync" }>;
    const next = { ...freshPullRequestWatch(START), headSha: "aaaaaaa1" };
    expect(decidePullRequestWatch(thread([watched]), sync(START, next), NOW)).toEqual({
      link: { ...watched, watch: next },
    });
    expect(decidePullRequestWatch(thread([watched]), sync(NOW, next), NOW)).toMatchObject({
      rejected: expect.stringContaining("ended"),
    });
    expect(decidePullRequestWatch(thread([link()]), sync(START, null), NOW)).toMatchObject({
      rejected: expect.stringContaining("ended"),
    });
    expect(decidePullRequestWatch(thread([watched]), sync(START, null), NOW)).toEqual({
      link: link(),
    });
  });
});
