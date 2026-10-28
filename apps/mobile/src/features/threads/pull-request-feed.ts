import type { PrFlowTimelinePullRequest } from "@t3tools/client-runtime/pr-flow";

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
