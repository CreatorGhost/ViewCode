import type { ReviewFindingEntry } from "@t3tools/client-runtime/review-findings";
import type { FileDiffMetadata } from "@pierre/diffs";
import { fencedCode, type PostedReviewFinding } from "@t3tools/shared/reviewFindings";

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
