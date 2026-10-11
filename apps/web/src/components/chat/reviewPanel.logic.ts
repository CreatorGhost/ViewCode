import type { ReviewFindingEntry, ReviewFindingKey } from "@t3tools/client-runtime/review-findings";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  fencedCode,
  type PostedReviewFinding,
  REVIEW_FINDING_SEVERITIES,
} from "@t3tools/shared/reviewFindings";

import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  inferReviewCommentFenceLanguage,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { isLineInFileDiff } from "../pullRequest/pullRequestDiff.logic";

export function postedReviewFindingsEqual(
  left: ReadonlyMap<string, PostedReviewFinding>,
  right: ReadonlyMap<string, PostedReviewFinding>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, entry] of left) {
    const other = right.get(key);
    if (other?.placement !== entry.placement || other.url !== entry.url) return false;
  }
  return true;
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
 * The order the panel lists and steps through findings, which Fix all lists them in too: most
 * severe first (blocker, important, nit, question), and within a severity those with no line in
 * the diff (General) first, then the diff's reading order.
 */
export function reviewIssueOrder(
  general: ReadonlyArray<Pick<ReviewFindingEntry, "key" | "finding">>,
  placed: ReadonlyArray<{ readonly entry: Pick<ReviewFindingEntry, "key" | "finding"> }>,
): ReadonlyArray<ReviewFindingKey> {
  const reading = [...general, ...placed.map((entry) => entry.entry)];
  const rank = (entry: Pick<ReviewFindingEntry, "finding">) =>
    REVIEW_FINDING_SEVERITIES.indexOf(entry.finding.severity);
  return reading.toSorted((left, right) => rank(left) - rank(right)).map((entry) => entry.key);
}

/**
 * Whether Fix all starts with a finding ticked: not one already sent to a chat, and not a question
 * or a finding the reviewer could not settle, which are not fixes. The reader can tick them.
 */
export function reviewFixAllInitiallyTicked(
  entry: Pick<ReviewFindingEntry, "key" | "finding" | "needsChecking">,
  sent: Readonly<Record<string, unknown>>,
): boolean {
  return (
    sent[entry.key] === undefined && !entry.needsChecking && entry.finding.severity !== "question"
  );
}

/**
 * The finding the panel goes to on its own: the first, once the change is read (until then every
 * finding sits under General, which is not where it stays), once only, and never after the
 * reader scrolled somewhere of their own.
 */
export function firstFindingToReveal(input: {
  readonly order: ReadonlyArray<ReviewFindingKey>;
  readonly diffPending: boolean;
  readonly revealed: boolean;
  readonly readerScrolled: boolean;
}): ReviewFindingKey | null {
  if (input.revealed || input.diffPending || input.readerScrolled) return null;
  return input.order[0] ?? null;
}

/**
 * Whether a file shows folded to one row: files with findings open and the rest fold, each until
 * the reader toggles it.
 */
export function reviewFileCollapsed(
  fileKey: string,
  filesWithFindings: ReadonlySet<string>,
  toggledFiles: ReadonlySet<string>,
): boolean {
  return filesWithFindings.has(fileKey) === toggledFiles.has(fileKey);
}

/**
 * What Fix all does: nothing without open findings, sends one straight away, and lists several
 * first so some can be left out.
 */
export function reviewFixAllMode(openCount: number): "none" | "send" | "choose" {
  return openCount === 0 ? "none" : openCount === 1 ? "send" : "choose";
}

/**
 * Whether Post all waits: a review still at work may change or drop the findings it sent so far.
 * A single finding, or ticked ones, can be posted meanwhile.
 */
export function reviewPostAllWaits(input: {
  readonly commentMode: boolean;
  readonly tickedCount: number;
  readonly stillReviewing: boolean;
}): boolean {
  return input.commentMode && input.tickedCount === 0 && input.stillReviewing;
}
