import { classifyLimitError } from "@t3tools/shared/usageLimit";

/**
 * Whether what Claude reported during a turn adds up to the account's usage
 * limit, which parks the thread and marks its agents out of usage. Only a
 * usage window Claude reported as rejected counts, and anything that says
 * otherwise wins:
 *
 * - the API's own words call it a throttle ("not your usage limit", as a
 *   gateway's 429 does; the CLI can still report a rejected window for it);
 * - the result failed with another HTTP status (a 500 or 529 is not a limit);
 * - the turn ended for another reason than an API error or a blocking limit.
 *
 * Mid-turn (the rate-limit notice) the result is not known yet, so its fields
 * are left out and only the window and the words decide.
 */
export function isClaudeUsageLimit(evidence: {
  readonly rejectedWindows: number;
  readonly assistantRateLimitText: string | undefined;
  readonly apiErrorStatus?: number | null | undefined;
  readonly terminalReason?: string | null | undefined;
}): boolean {
  if (evidence.rejectedWindows === 0) return false;
  if (classifyLimitError(evidence.assistantRateLimitText) === "transient") return false;
  if (evidence.apiErrorStatus != null && evidence.apiErrorStatus !== 429) return false;
  return (
    evidence.terminalReason == null ||
    evidence.terminalReason === "api_error" ||
    evidence.terminalReason === "blocking_limit"
  );
}
