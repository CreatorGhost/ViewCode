// @effect-diagnostics globalDate:off -- Formats a wall-clock time for display; it never schedules anything.
/**
 * Shared vocabulary for "the provider's usage limit is spent": how an error
 * message is recognised as one, and how a reset time is worded for people.
 */

/**
 * Provider errors that retrying cannot fix until a quota or plan changes.
 * Providers report these only as text on the session, so the match stays
 * narrow; a context-length error is a different failure (see below). The
 * reset-time parser (server `usageResetTime.ts`) reads the same messages, so
 * keep the two in step.
 */
const LIMIT_ERROR_PATTERN =
  /usage[ _-]?limit|rate[ _-]?limit|quota|plan limit|MODEL_NOT_IN_PLAN|not (?:in|available on) (?:your )?plan|\bcredits?\b|insufficient (?:credit|balance|funds)|\b429\b|too many requests|limit reached|hit your (?:\w+ )?limit|out of extra usage|(?:5-hour|five-hour|weekly|daily) limit/i;
/** "Context window exceeded" and friends: the conversation is too long, the account is fine. */
const CONTEXT_LENGTH_PATTERN =
  /context[ _-]?(?:window|length|limit)|maximum context|prompt is too long|too many tokens|max(?:imum)?[ _-]tokens/i;

export function isLimitError(message: string | null | undefined): message is string {
  return (
    typeof message === "string" &&
    LIMIT_ERROR_PATTERN.test(message) &&
    !CONTEXT_LENGTH_PATTERN.test(message)
  );
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When a limit resets or a resume runs, in the viewer's own clock:
 * "3:31 PM" today, "tomorrow at 9:00 AM", "Thursday at 9:00 AM" within the
 * next week, otherwise "Oct 8, 9:00 AM".
 */
export function formatResumeTime(
  at: number | string | Date,
  nowMs: number,
  locale?: string | undefined,
): string {
  const date = new Date(at);
  // Newer ICU puts a narrow no-break space before AM/PM; plain text is safer to compare and paste.
  const time = date
    .toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    .replace(/[  ]/g, " ");
  const days = Math.round((startOfDay(date) - startOfDay(new Date(nowMs))) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days <= 6) {
    return `${date.toLocaleDateString(locale, { weekday: "long" })} at ${time}`;
  }
  return `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * `formatResumeTime` ready to follow a verb: "at 3:31 PM", "tomorrow at 9:00 AM",
 * "Thursday at 9:00 AM" or "on Oct 8, 9:00 AM".
 */
export function formatResumeAt(
  at: number | string | Date,
  nowMs: number,
  locale?: string | undefined,
): string {
  const text = formatResumeTime(at, nowMs, locale);
  if (text.includes(" at ")) return text;
  return /^\d{1,2}:\d{2}/.test(text) ? `at ${text}` : `on ${text}`;
}
