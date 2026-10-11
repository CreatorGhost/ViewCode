import {
  REVIEW_FINDINGS_ACTIVITY_KIND,
  ReviewFindingsActivityPayload,
  type OrchestrationThreadActivity,
  type ReviewFinding,
  type ReviewFindingToFix,
  type ReviewFindingsTarget,
  type ReviewFindingSeverity,
  type ReviewVerdict,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Most severe first: the order findings are grouped in. */
export const REVIEW_FINDING_SEVERITIES: ReadonlyArray<ReviewFindingSeverity> = [
  "blocker",
  "important",
  "nit",
  "question",
];

export const REVIEW_FINDING_SEVERITY_LABELS: Record<ReviewFindingSeverity, string> = {
  blocker: "Blocker",
  important: "Important",
  nit: "Nit",
  question: "Question",
};

export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approve",
  "approve-with-nits": "Approve with nits",
  "request-changes": "Request changes",
};

const decodePayload = Schema.decodeUnknownOption(ReviewFindingsActivityPayload);

/** The findings a review activity carries, or undefined for another activity or a bad payload. */
export function readReviewFindings(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): ReviewFindingsActivityPayload | undefined {
  if (activity.kind !== REVIEW_FINDINGS_ACTIVITY_KIND) return undefined;
  return Option.getOrUndefined(decodePayload(activity.payload));
}

/**
 * The findings activity a thread shows: the latest one. Activities are append-only, so a
 * re-review replaces the earlier set by coming after it.
 */
export function latestReviewFindingsActivityId(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "id" | "kind">>,
): string | null {
  return (
    activities.findLast((activity) => activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND)?.id ?? null
  );
}

/**
 * A markdown code block holding `code` as it stands: the fence outgrows any backtick run inside
 * it, and the file's extension names the language when it looks like one.
 */
export function fencedCode(code: string, path: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1] ?? "";
  return `${fence}${extension}\n${code.replace(/\n+$/, "")}\n${fence}`;
}

/** The expanded body of one finding: where it is, what is wrong, and the fix. */
export function reviewFindingMarkdown(finding: ReviewFinding): string {
  const parts = [`\`${reviewFindingLocation(finding)}\``, finding.detail];
  if (finding.rule) parts.push(`Rule: ${finding.rule}`);
  if (finding.suggestedFix) {
    parts.push(`Suggested fix:\n\n${fencedCode(finding.suggestedFix, finding.path)}`);
  }
  return parts.join("\n\n");
}

/**
 * The message that hands findings to a coding session. The findings come from another agent and
 * may be wrong, so the session is told to verify each one before fixing it and to say which it
 * skipped. Findings sent together ("Fix all") travel in one message.
 */
export function buildReviewFixMessage(input: {
  readonly reviewTitle: string;
  readonly target: ReviewFindingsTarget;
  readonly findings: ReadonlyArray<ReviewFindingToFix>;
}): string {
  const source =
    input.target.kind === "pull-request"
      ? `on PR #${input.target.number} (${input.target.url})`
      : "on the local changes";
  const what = input.findings.length === 1 ? "this review finding" : "these review findings";
  const header =
    `Fix ${what} from "${input.reviewTitle}" ${source}. Another agent found them: verify each ` +
    "against the code first; fix the ones that hold, skip the ones that don't and say why. Run " +
    "the project's checks for what you touch.";
  const blocks = input.findings.map(({ finding, needsChecking }, index) => {
    const facts = [
      `Severity: ${finding.severity}`,
      `Confidence: ${finding.confidence}`,
      `Location: ${reviewFindingLocation(finding)}`,
    ];
    if (finding.preExisting) facts.push("Pre-existing: the change makes it worse or reachable");
    if (needsChecking) facts.push("Needs checking: the reviewer could not settle it");
    const lines = [`${index + 1}. ${finding.title}`, facts.join(" · "), "", finding.detail];
    if (finding.rule) lines.push("", `Rule: ${finding.rule}`);
    if (finding.suggestedFix) {
      lines.push("", "Suggested fix:", fencedCode(finding.suggestedFix, finding.path));
    }
    return lines.join("\n");
  });
  return [header, ...blocks].join("\n\n");
}

/** `path:line` or `path:line-endLine`, the way the report cites a location. */
export function reviewFindingLocation(finding: {
  readonly path: string;
  readonly line?: number | undefined;
  readonly endLine?: number | undefined;
}): string {
  if (finding.line === undefined) return finding.path;
  const range =
    finding.endLine !== undefined && finding.endLine !== finding.line
      ? `${finding.line}-${finding.endLine}`
      : `${finding.line}`;
  return `${finding.path}:${range}`;
}
