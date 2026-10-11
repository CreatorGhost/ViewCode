import {
  REVIEW_FINDINGS_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ReviewFinding,
  type ReviewFindingsActivityPayload,
  type ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  fencedCode,
  readReviewFindings,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICT_LABELS,
} from "@t3tools/shared/reviewFindings";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  inferReviewCommentFenceLanguage,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { isLineInFileDiff } from "../pullRequest/pullRequestDiff.logic";

type FindingsActivity = Pick<OrchestrationThreadActivity, "id" | "kind" | "payload" | "createdAt">;

interface ThreadFindings {
  readonly id: ThreadId;
  readonly title: string;
  readonly activities: ReadonlyArray<FindingsActivity>;
}

/** The findings the Review panel shows, and the review thread that submitted them. */
export interface ReviewFindingsSource {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly activityId: OrchestrationThreadActivity["id"];
  readonly createdAt: string;
  readonly findings: ReviewFindingsActivityPayload;
}

/** A thread's latest findings activity; activities are append-only, so a re-review comes last. */
export function latestReviewFindingsActivity<T extends Pick<FindingsActivity, "kind">>(
  activities: ReadonlyArray<T>,
): T | undefined {
  return activities.findLast((activity) => activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND);
}

// Activities are immutable, so a payload is decoded once however often the panel recomputes.
const decodedFindings = new WeakMap<FindingsActivity, ReviewFindingsActivityPayload | null>();

function decodeFindings(activity: FindingsActivity): ReviewFindingsActivityPayload | null {
  let findings = decodedFindings.get(activity);
  if (findings === undefined) {
    findings = readReviewFindings(activity) ?? null;
    decodedFindings.set(activity, findings);
  }
  return findings;
}

function latestSource(thread: ThreadFindings): ReviewFindingsSource | null {
  const activity = latestReviewFindingsActivity(thread.activities);
  const findings = activity === undefined ? null : decodeFindings(activity);
  if (activity === undefined || findings === null) return null;
  return {
    threadId: thread.id,
    threadTitle: thread.title,
    activityId: activity.id,
    createdAt: activity.createdAt,
    findings,
  };
}

/**
 * Which findings a thread's Review panel shows: the thread's own latest set when it is itself a
 * review, otherwise the newest set any linked thread submitted about one of this thread's pull
 * requests. A review of something else, such as another layer of a stack, does not count.
 */
export function selectReviewFindingsSource(input: {
  readonly thread: ThreadFindings;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly linkedThreads: ReadonlyArray<ThreadFindings>;
}): ReviewFindingsSource | null {
  const own = latestSource(input.thread);
  if (own !== null) return own;
  let newest: ReviewFindingsSource | null = null;
  for (const thread of input.linkedThreads) {
    if (thread.id === input.thread.id) continue;
    const source = latestSource(thread);
    if (source === null || source.findings.target.kind !== "pull-request") continue;
    const target = source.findings.target;
    if (!input.pullRequests.some((key) => threadPullRequestKeysEqual(key, target))) continue;
    if (newest === null || source.createdAt > newest.createdAt) newest = source;
  }
  return newest;
}

/** How many linked threads the panel reads for findings; each one is a thread subscription. */
export const REVIEW_SOURCE_CANDIDATE_LIMIT = 5;

/**
 * The threads that may hold a review of this thread's pull requests, most recently active first:
 * other unarchived threads linked to one of them. Only these have their activities read.
 */
export function reviewSourceCandidates<
  T extends Pick<OrchestrationThreadShell, "id" | "pullRequests" | "archivedAt" | "updatedAt">,
>(input: {
  readonly threadId: ThreadId;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
  readonly threads: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  if (input.pullRequests.length === 0) return [];
  return input.threads
    .filter(
      (thread) =>
        thread.id !== input.threadId &&
        thread.archivedAt === null &&
        visibleThreadPullRequests(thread.pullRequests).some((link) =>
          input.pullRequests.some((key) => threadPullRequestKeysEqual(link, key)),
        ),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, REVIEW_SOURCE_CANDIDATE_LIMIT);
}

/** A finding's place in the payload: which list, and its index there. */
export type ReviewFindingKey = `${"finding" | "check"}:${number}`;

export interface ReviewFindingEntry {
  readonly key: ReviewFindingKey;
  readonly finding: ReviewFinding;
  /** The reviewer could not settle it. */
  readonly needsChecking: boolean;
}

/** Every finding of a set, the settled ones first, each under a key that survives re-renders. */
export function reviewFindingEntries(
  findings: Pick<ReviewFindingsActivityPayload, "findings" | "needsChecking">,
): ReadonlyArray<ReviewFindingEntry> {
  return [
    ...findings.findings.map((finding, index) => ({
      key: `finding:${index}` as const,
      finding,
      needsChecking: false,
    })),
    ...findings.needsChecking.map((finding, index) => ({
      key: `check:${index}` as const,
      finding,
      needsChecking: true,
    })),
  ];
}

export interface ReviewDiffFile {
  readonly fileKey: string;
  readonly path: string;
  readonly fileDiff: FileDiffMetadata;
}

/** A finding pinned under the last line of its range that the diff shows. */
export interface PlacedReviewFinding {
  readonly entry: ReviewFindingEntry;
  readonly fileKey: string;
  readonly startLine: number;
  readonly lineNumber: number;
}

/**
 * Where each finding shows: under its lines in the diff, or in the General list above it when it
 * names no line, or a file or line the diff does not show (the change moved on since the review,
 * or the host withheld that part). Both lists are in reading order, which is the order Previous
 * and Next walk: General first, then file by file, line by line.
 */
export function placeReviewFindings(
  entries: ReadonlyArray<ReviewFindingEntry>,
  files: ReadonlyArray<ReviewDiffFile>,
): {
  readonly general: ReadonlyArray<ReviewFindingEntry>;
  readonly placed: ReadonlyArray<PlacedReviewFinding>;
} {
  const general: ReviewFindingEntry[] = [];
  const placed: PlacedReviewFinding[] = [];
  for (const entry of entries) {
    const { line, endLine, path } = entry.finding;
    const file =
      line === undefined
        ? undefined
        : files.find(
            (candidate) =>
              candidate.path === path && isLineInFileDiff(candidate.fileDiff, "right", line),
          );
    if (line === undefined || file === undefined) {
      general.push(entry);
      continue;
    }
    const lastLine =
      endLine !== undefined && isLineInFileDiff(file.fileDiff, "right", endLine) ? endLine : line;
    placed.push({ entry, fileKey: file.fileKey, startLine: line, lineNumber: lastLine });
  }
  const fileOrder = new Map(files.map((file, index) => [file.fileKey, index]));
  placed.sort(
    (left, right) =>
      (fileOrder.get(left.fileKey) ?? 0) - (fileOrder.get(right.fileKey) ?? 0) ||
      left.lineNumber - right.lineNumber,
  );
  return { general, placed };
}

/**
 * A finding's lines as a review-comment chip, the same "a.ts L12 to L14" chip annotating a file
 * gives. It carries no text: the request around it does.
 */
function reviewFindingChip(activityId: string, entry: ReviewFindingEntry): ReviewCommentContext {
  const { finding } = entry;
  const startLine = finding.line ?? 1;
  const endLine = finding.endLine ?? startLine;
  return {
    id: `review-finding:${activityId}:${entry.key}`,
    sectionId: `review:${activityId}`,
    sectionTitle: "Agent review finding",
    filePath: finding.path,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel:
      finding.line === undefined
        ? "file"
        : endLine === startLine
          ? `L${startLine}`
          : `L${startLine} to L${endLine}`,
    text: "",
    diff: "",
    fenceLanguage: inferReviewCommentFenceLanguage(finding.path),
  };
}

function findingBody(entry: ReviewFindingEntry): ReadonlyArray<string> {
  const { finding } = entry;
  const parts = [finding.detail];
  if (entry.needsChecking) parts.push("The reviewer could not settle this one.");
  if (finding.rule) parts.push(`Rule: ${finding.rule}`);
  if (finding.suggestedFix) {
    parts.push(`Suggested fix:\n\n${fencedCode(finding.suggestedFix, finding.path)}`);
  }
  return parts;
}

/**
 * "Fix with agent" for the chat beside the panel: a request the reader can edit before sending,
 * asking the agent to verify each finding before fixing it, since another agent wrote them. Each
 * finding's lines ride along as a chip, whose record has to be added to the draft with the text.
 */
export function reviewFindingsFixPrompt(input: {
  readonly activityId: string;
  readonly entries: ReadonlyArray<ReviewFindingEntry>;
}): { readonly prompt: string; readonly comments: ReadonlyArray<ReviewCommentContext> } {
  const comments = input.entries.map((entry) => reviewFindingChip(input.activityId, entry));
  const chips = comments.map((comment) =>
    formatInlineContextReference(reviewCommentContextReference(comment)),
  );
  const only = input.entries.length === 1 ? input.entries[0] : undefined;
  if (only !== undefined) {
    return {
      prompt: [
        `Verify this issue exists and fix it: ${chips[0]}`,
        `**${only.finding.title}**`,
        ...findingBody(only),
      ].join("\n\n"),
      comments,
    };
  }
  const blocks = input.entries.map((entry, index) =>
    [`${index + 1}. ${chips[index]} **${entry.finding.title}**`, ...findingBody(entry)].join(
      "\n\n",
    ),
  );
  return {
    prompt: [
      "Verify each of these issues exists and fix the ones that do; say which you skipped and why:",
      ...blocks,
    ].join("\n\n"),
    comments,
  };
}

/**
 * Where a posted review's own text starts until the reader rewrites it: the reviewer's verdict,
 * then the two most severe findings being posted, the settled ones first.
 */
export function reviewPostOverallComment(
  verdict: ReviewFindingsActivityPayload["verdict"],
  entries: ReadonlyArray<ReviewFindingEntry>,
): string {
  const top = entries
    .toSorted(
      (left, right) =>
        Number(left.needsChecking) - Number(right.needsChecking) ||
        REVIEW_FINDING_SEVERITIES.indexOf(left.finding.severity) -
          REVIEW_FINDING_SEVERITIES.indexOf(right.finding.severity),
    )
    .slice(0, 2)
    .map((entry) => `- ${entry.finding.title}`);
  return [`${REVIEW_VERDICT_LABELS[verdict]}.`, ...(top.length > 0 ? [top.join("\n")] : [])].join(
    "\n\n",
  );
}
