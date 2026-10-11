import {
  normalizeCompactToolLabel,
  workLogEntryIsToolLike,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  REVIEW_FINDINGS_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { readReviewFindings } from "@t3tools/shared/reviewFindings";

import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";

// A step is one of the reviewer's last tool calls; older work cannot be the current step.
const RECENT_ACTIVITIES = 40;
const SUBMIT_FINDINGS_TOOL = "submit_review_findings";

function mentionsSubmitFindings(entry: WorkLogEntry): boolean {
  const data = entry.toolData;
  const names = [
    entry.toolTitle,
    entry.label,
    data !== null && typeof data === "object" && "tool" in data ? String(data.tool) : undefined,
    data !== null && typeof data === "object" && "toolName" in data
      ? String(data.toolName)
      : undefined,
  ];
  return names.some((name) => name?.includes(SUBMIT_FINDINGS_TOOL) === true);
}

/** "Sent 3 findings so far" from the reviewer's latest findings, or that it is sending them. */
function findingsSentLine(activities: ReadonlyArray<OrchestrationThreadActivity>): string {
  const latest = activities.findLast((activity) => activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND);
  const findings = latest === undefined ? undefined : readReviewFindings(latest);
  if (findings === undefined) return "Sending findings";
  const count = findings.findings.length + findings.needsChecking.length;
  const counted = `${count} ${count === 1 ? "finding" : "findings"}`;
  return findings.complete === false ? `Sent ${counted} so far` : `Sent ${counted}`;
}

/** A tool's output rather than a description of the step: never shown as the step. */
function looksLikeRawOutput(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes('":');
}

function toolTitleLabel(entry: WorkLogEntry): string | null {
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label).trim();
  if (heading.length === 0 || looksLikeRawOutput(heading)) return null;
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

/**
 * The reviewer's current step in the words the chat's live activity row uses ("Reading
 * retry.ts"), from its latest tool call; null before it calls any. Its own findings calls read
 * as "Sent 1 finding so far", and a step whose words would be the tool's raw output reads as the
 * tool's name instead.
 */
export function reviewWorkLine(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  workspaceRoot: string | undefined,
): string | null {
  const entries = deriveWorkLogEntries(activities.slice(-RECENT_ACTIVITIES));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.reviewFindings !== undefined || mentionsSubmitFindings(entry)) {
      return findingsSentLine(activities);
    }
    if (!workLogEntryIsToolLike(entry) || entry.tone === "thinking") continue;
    const label = liveWorkEntryLabel(entry, workspaceRoot, index === entries.length - 1);
    return looksLikeRawOutput(label) ? toolTitleLabel(entry) : label;
  }
  return null;
}
