import type {
  OrchestrationCommand,
  OrchestrationThread,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestLink,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** The watch to record once the agent was told, or right away when nothing is reported. */
  readonly next: ThreadPullRequestWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

/** A watch with nothing reported yet. Its first pass reports checks that already finished. */
export function freshPullRequestWatch(startedAt: string): ThreadPullRequestWatch {
  return {
    startedAt,
    headSha: null,
    failedChecks: [],
    passed: false,
    remarksThrough: startedAt,
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
}

export function pullRequestWatchesEqual(
  left: ThreadPullRequestWatch,
  right: ThreadPullRequestWatch,
): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes
  );
}

// "action-required" is a finished check that needs someone, so the agent hears about it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/**
 * Compares a watched pull request with what its agent was last told. Each check is reported as
 * soon as it fails, so a check that never finishes cannot hold the news back. "Passed" is
 * reported once every check on the head commit finished without failing. Remarks count when
 * someone other than the agent's own account wrote them, so its own replies never wake it.
 * `remarks` is null when the conversation could not be read whole; remarks then wait.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  // An empty list keeps the last state: a host can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  if (detail.checks.length > 0) {
    const failed = detail.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    // A check that runs again leaves the list, so a rerun that fails again is reported.
    failedChecks = failed.map((check) => check.name);
    const passedNow = detail.checks.every(
      (check) => check.status !== "pending" && !isFailedCheck(check),
    );
    if (passedNow && !passed) changes.push({ kind: "checks-passed", count: detail.checks.length });
    passed = passedNow;
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  // GitHub times are per second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(remark.createdAt);
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(remark.createdAt)));
  const atLatest = fresh.filter((remark) => Date.parse(remark.createdAt) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : atLatest[0]!.createdAt;
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is the host still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): Array<string> {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${context.commit}:`,
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.count === 1 ? "check" : "checks"} passed${context.commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author?.login ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

/** The message that wakes the agent. */
export function pullRequestWatchMessage(input: {
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
}): string {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  return [
    `Update on pull request #${input.number} (${input.url}), which ViewCode is watching for you:`,
    ...changes.flatMap((change) => changeLines(change, context)),
    "",
    exhausted
      ? `ViewCode stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`
      : "Look into each item and act on it as your task requires. ViewCode keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call unwatch_pull_request first.",
  ].join("\n");
}

type WatchCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.pull-request.watch" | "thread.pull-request-watch.sync" }
>;

/** The link without its watch. */
export function withoutPullRequestWatch(link: ThreadPullRequestLink): ThreadPullRequestLink {
  const { watch: _watch, ...rest } = link;
  return rest;
}

/**
 * The link a watch command leaves behind, or why the command changes nothing. Starting a watch
 * on an unlinked pull request links it in the same step. A sync applies only while the watch
 * it read is still on, so a stop or restart that lands during the host read wins.
 */
export function decidePullRequestWatch(
  thread: Pick<
    OrchestrationThread,
    "pullRequests" | "archivedAt" | "settledOverride" | "settledAt"
  >,
  command: WatchCommand,
  now: string,
): { readonly link: ThreadPullRequestLink } | { readonly rejected: string } {
  const key = normalizeThreadPullRequestKey(command);
  const existing = thread.pullRequests.find(
    (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key),
  );
  if (command.type === "thread.pull-request-watch.sync") {
    if (existing?.watch?.startedAt !== command.startedAt) {
      return { rejected: "the pull request watch ended while it was read" };
    }
    return {
      link:
        command.watch === null
          ? withoutPullRequestWatch(existing)
          : { ...existing, watch: command.watch },
    };
  }
  if (!command.watching) {
    return existing?.watch === undefined
      ? { rejected: "the pull request is not watched" }
      : { link: withoutPullRequestWatch(existing) };
  }
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  ) {
    return { rejected: "the thread is archived or settled; unsettle it before watching" };
  }
  if (existing === undefined) {
    return command.link === undefined
      ? { rejected: "the pull request is not linked" }
      : {
          link: {
            ...key,
            url: command.link.url,
            source: command.link.source,
            linkedAt: now,
            snapshot: null,
            stack: null,
            watch: freshPullRequestWatch(now),
          },
        };
  }
  if (existing.watch !== undefined) return { rejected: "the pull request is already watched" };
  const state = existing.snapshot?.state ?? "open";
  if (state !== "open") return { rejected: `the pull request is ${state}` };
  return { link: { ...existing, watch: freshPullRequestWatch(now) } };
}
