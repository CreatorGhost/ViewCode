import {
  type PrFlow,
  type PrFlowCheck,
  type PrFlowTimelinePullRequest,
  type PrFlowTone,
  prFlowStatus,
} from "@t3tools/client-runtime/pr-flow";

import type { AppSymbolName } from "../../components/AppSymbol";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";

/** One of the thread's pull requests as a card in the conversation, where the thread got it. */
export interface PullRequestFeedEntry {
  readonly type: "pull-request";
  readonly id: string;
  readonly createdAt: string;
  /** `threadPullRequestKeyOf`: host, repository and number. */
  readonly pullRequestKey: string;
  /** The thread's current pull request: the one live card, the rest fold. */
  readonly current: boolean;
}

interface FeedEntryLike {
  readonly type: string;
  readonly createdAt: string;
}

// Rows of one turn's work log hang together; a card between two of them would split the log.
const WORK_LOG_TYPES: ReadonlySet<string> = new Set([
  "activity-group",
  "work-toggle",
  "thinking",
  "agent-spawn",
]);

/**
 * Web's `insertPullRequestRows` for the phone feed: each card goes before the first entry that
 * came later than its link, never between two work-log rows, so a card linked mid-turn lands
 * after that turn's steps so far. One linked after everything sits at the end.
 */
export function insertPullRequestFeedEntries<Entry extends FeedEntryLike>(
  entries: ReadonlyArray<Entry>,
  input: {
    readonly pullRequests: ReadonlyArray<PrFlowTimelinePullRequest>;
    readonly currentKey: string | null;
  },
): ReadonlyArray<Entry | PullRequestFeedEntry> {
  const { pullRequests, currentKey } = input;
  if (pullRequests.length === 0) return entries;
  const result: Array<Entry | PullRequestFeedEntry> = [...entries];
  // Oldest first: a later card always lands after an earlier one in the same gap.
  const ordered = [...pullRequests].sort(
    (left, right) => Date.parse(left.anchorAt) - Date.parse(right.anchorAt),
  );
  for (const pullRequest of ordered) {
    const anchor = Date.parse(pullRequest.anchorAt);
    let index = Number.isFinite(anchor)
      ? result.findIndex(
          (entry) => entry.type !== "pull-request" && Date.parse(entry.createdAt) > anchor,
        )
      : -1;
    if (index === -1) index = result.length;
    // Cards already placed here are as old or older, so this one goes after them.
    while (
      result[index]?.type === "pull-request" ||
      (WORK_LOG_TYPES.has(result[index]?.type ?? "") &&
        WORK_LOG_TYPES.has(result[index - 1]?.type ?? ""))
    ) {
      index += 1;
    }
    result.splice(index, 0, {
      type: "pull-request",
      id: `pull-request:${pullRequest.key}`,
      createdAt: pullRequest.anchorAt,
      pullRequestKey: pullRequest.key,
      current: pullRequest.key === currentKey,
    });
  }
  return result;
}

const TONES = {
  busy: { icon: "clock", tint: "accent-icon-muted", text: "text-foreground-muted" },
  warning: {
    icon: "exclamationmark.triangle",
    tint: "accent-warning-foreground",
    text: "text-warning-foreground",
  },
  success: {
    icon: "checkmark.circle",
    tint: "accent-adaptive-emerald-600-400",
    text: "text-adaptive-emerald-600-400",
  },
  merged: {
    icon: PullRequestGlyph.merged,
    tint: "accent-adaptive-violet-600-400",
    text: "text-adaptive-violet-600-400",
  },
} as const satisfies Record<PrFlowTone, { icon: AppSymbolName; tint: string; text: string }>;

/** Checks named on the card; the rest are counted. */
const SHOWN_CHECKS = 4;
const CHECK_ORDER: Record<PrFlowCheck["state"], number> = {
  failed: 0,
  running: 1,
  passed: 2,
  skipped: 3,
};

function checksPassedLabel(list: ReadonlyArray<PrFlowCheck>): string {
  const passed = list.filter((check) => check.state === "passed").length;
  if (passed === list.length) return `${passed} ${passed === 1 ? "check" : "checks"} passed`;
  return `${passed} passed, ${list.length - passed} skipped`;
}

/**
 * What the phone's card says: the status line in its tone, a checks summary with the checks worth
 * reading by name (failed, then running), and whether the card wears the conflict glow.
 */
export function pullRequestCardPresentation(flow: PrFlow) {
  const status = prFlowStatus(flow);
  const checks = flow.checks;
  const listed =
    checks === null
      ? []
      : checks.list
          .filter((check) => check.state === "failed" || check.state === "running")
          .sort((left, right) => CHECK_ORDER[left.state] - CHECK_ORDER[right.state]);
  return {
    status: { label: status.label, ...TONES[status.tone] },
    checks:
      checks === null || checks.total === 0
        ? null
        : checks.failed > 0
          ? ({
              label: `${checks.failed} of ${checks.total} checks failed`,
              icon: "exclamationmark.circle",
              tint: "accent-danger-foreground",
            } as const)
          : checks.done < checks.total
            ? ({
                label: `Checks running, ${checks.done} of ${checks.total} done`,
                icon: "clock",
                tint: "accent-warning-foreground",
              } as const)
            : ({
                label: checksPassedLabel(checks.list),
                icon: "checkmark.circle",
                tint: "accent-adaptive-emerald-600-400",
              } as const),
    namedChecks: listed.slice(0, SHOWN_CHECKS),
    moreChecks: Math.max(0, listed.length - SHOWN_CHECKS),
    conflictGlow: flow.phase === "conflicts" || flow.phase === "resolving",
  } as const;
}
