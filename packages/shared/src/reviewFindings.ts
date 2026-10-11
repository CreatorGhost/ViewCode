import {
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  ReviewFindingsActivityPayload,
  ReviewFindingsPostedActivityPayload,
  type OrchestrationThreadActivity,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewPosition,
  type PullRequestReviewVerdict,
  type ReviewFinding,
  type ReviewFindingPlacement,
  type ReviewFindingToFix,
  type ReviewFindingsMode,
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

/** One account's key in `pullRequestReviewStyles`: its host and login, as hosts compare them. */
export function reviewStyleKey(host: string, login: string): string {
  return `${host.toLowerCase()}/${login.toLowerCase()}`;
}

/** What a review's findings are for; findings recorded before there was a choice are fixes. */
export function reviewFindingsMode(
  payload: Pick<ReviewFindingsActivityPayload, "mode">,
): ReviewFindingsMode {
  return payload.mode ?? "fix";
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

const decodePostedPayload = Schema.decodeUnknownOption(ReviewFindingsPostedActivityPayload);

export interface PostedReviewFinding {
  readonly placement: ReviewFindingPlacement;
  /** The pull request the review is on. */
  readonly url: string;
  readonly verdict: PullRequestReviewVerdict;
}

/**
 * Which findings of one findings activity were posted to the pull request, by key, from the
 * records the server appends to the review thread after each review it posts.
 */
export function postedReviewFindings(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
  findingsActivityId: string,
): ReadonlyMap<string, PostedReviewFinding> {
  const posted = new Map<string, PostedReviewFinding>();
  for (const activity of activities) {
    if (activity.kind !== REVIEW_FINDINGS_POSTED_ACTIVITY_KIND) continue;
    const payload = Option.getOrUndefined(decodePostedPayload(activity.payload));
    if (payload === undefined || payload.findingsActivityId !== findingsActivityId) continue;
    for (const { key, placement } of payload.findings) {
      posted.set(key, { placement, url: payload.url, verdict: payload.verdict });
    }
  }
  return posted;
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

/**
 * The verdict a review of the findings is submitted with until the reader picks another: request
 * changes or approve where the reviewer said so, a plain comment for anything in between.
 */
export function reviewSubmitVerdictFor(verdict: ReviewVerdict): PullRequestReviewVerdict {
  switch (verdict) {
    case "request-changes":
      return "request-changes";
    case "approve":
      return "approve";
    case "approve-with-nits":
      return "comment";
  }
}

/** The lines of a pull request's head that a host takes a comment on, by file. */
export type ReviewCommentableLines = ReadonlyMap<
  string,
  {
    /** What the file was called before the change, where that differs. */
    readonly oldPath: string | undefined;
    readonly lines: ReadonlyMap<number, PullRequestReviewPosition>;
  }
>;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function patchPath(header: string): string | null {
  const path = header.replace(/\t.*$/, "");
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

/**
 * Which lines of the head a unified diff shows, added or unchanged: hosts refuse a comment on any
 * other line, and refuse the whole review with it. Hunks are read by their counts, so a removed
 * line that happens to start with `--` is not mistaken for a file header.
 */
export function reviewCommentableLines(patch: string): ReviewCommentableLines {
  const files = new Map<
    string,
    { oldPath: string | undefined; lines: Map<number, PullRequestReviewPosition> }
  >();
  let oldPath: string | null = null;
  let file: { lines: Map<number, PullRequestReviewPosition> } | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0];
      if (mark === "+") {
        file?.lines.set(newLine, { kind: "added", newLine });
        newLine++;
        newLeft--;
      } else if (mark === "-") {
        oldLine++;
        oldLeft--;
      } else if (mark === " " || line === "") {
        file?.lines.set(newLine, { kind: "context", oldLine, newLine, side: "right" });
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      }
      // "\ No newline at end of file" belongs to the line before it.
      continue;
    }
    if (line.startsWith("diff ")) {
      oldPath = null;
      file = null;
    } else if (line.startsWith("--- ")) {
      oldPath = patchPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const path = patchPath(line.slice(4));
      if (path === null) {
        file = null;
        continue;
      }
      const entry = files.get(path) ?? {
        oldPath: oldPath !== null && oldPath !== path ? oldPath : undefined,
        lines: new Map<number, PullRequestReviewPosition>(),
      };
      files.set(path, entry);
      file = entry;
    } else {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk === null) continue;
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    }
  }
  return files;
}

/**
 * A finding as the review comment that carries it, exactly as posted: the reviewer's words, then
 * its fix as code. One in the review's own text also says what and where it is, since no line
 * places it.
 */
export function reviewFindingCommentBody(
  finding: ReviewFinding,
  placement: ReviewFindingPlacement,
): string {
  const parts =
    placement === "inline"
      ? [finding.detail]
      : [`**${finding.title}** (\`${reviewFindingLocation(finding)}\`)`, finding.detail];
  if (finding.suggestedFix) parts.push(fencedCode(finding.suggestedFix, finding.path));
  return parts.join("\n\n");
}

/**
 * One review carrying findings: each on its line where the diff shows that line, the rest in the
 * review's text under the reader's overall comment. Without the diff every finding goes in the
 * text, which a host never refuses.
 */
export function buildReviewFromFindings(input: {
  readonly overallComment: string;
  readonly findings: ReadonlyArray<{ readonly key: string; readonly finding: ReviewFinding }>;
  readonly commentable: ReviewCommentableLines | null;
}): {
  readonly body: string;
  readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
  readonly placements: ReadonlyArray<{
    readonly key: string;
    readonly placement: ReviewFindingPlacement;
  }>;
} {
  const comments: Array<PullRequestReviewCommentDraft> = [];
  const inBody: Array<string> = [];
  const placements = input.findings.map(({ key, finding }) => {
    const file = input.commentable?.get(finding.path);
    const position = finding.line === undefined ? undefined : file?.lines.get(finding.line);
    if (file === undefined || position === undefined) {
      inBody.push(reviewFindingCommentBody(finding, "body"));
      return { key, placement: "body" as const };
    }
    comments.push({
      path: finding.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      position,
      body: reviewFindingCommentBody(finding, "inline"),
    });
    return { key, placement: "inline" as const };
  });
  const overall = input.overallComment.trim();
  const body = [...(overall.length > 0 ? [overall] : []), ...inBody].join("\n\n");
  return { body, comments, placements };
}
