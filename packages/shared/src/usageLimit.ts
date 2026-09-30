// @effect-diagnostics globalDate:off -- Formats a wall-clock time for display; it never schedules anything.
/**
 * Shared vocabulary for "the provider's usage limit is spent": how an error
 * message is recognised as one, and how a reset time is worded for people.
 */

/**
 * Provider errors that retrying cannot fix until a quota or plan changes.
 * Providers report these only as text, so the match is anchored to their own
 * phrasing ("usage limit reached", "hit your limit", "5-hour limit", "out of
 * extra usage", "insufficient credit", "usage limit reached|<unix>") rather
 * than loose words such as "429", "credits" or "quota", which turn up in
 * unrelated errors. The reset-time parser (server `usageResetTime.ts`) reads
 * the same messages, so keep the two in step.
 */
const USAGE_LIMIT_PATTERN =
  /\busage limit\b|usage_limit_(?:reached|exceeded)|hit your (?:\w+ )?limit|limit reached\s*\|\s*\d{9,}|out of (?:extra )?usage|\b(?:5-hour|five-hour|weekly|daily|monthly|session) (?:usage )?limit\b|\bplan limit\b|MODEL_NOT_IN_PLAN|not (?:in|available on) (?:your )?plan|insufficient[ _](?:credits?|balance|funds|quota)|credit balance is too low|out of credits|(?:exceeded|exhausted) (?:your )?(?:current )?quota|quota (?:exceeded|exhausted)/i;
/**
 * A server or proxy throttling requests for a moment: HTTP 429 named as such,
 * "rate limit", overload. Retrying shortly fixes these; the account is fine.
 */
const TRANSIENT_LIMIT_PATTERN =
  /\b429\b[^\n]{0,40}(?:too many requests|rate[ _-]?limit)|too many requests|rate[ _-]limit|ratelimit(?:ed|error)|temporarily (?:limiting|rate[ _-]limited|throttl)|throttl(?:ed|ing)|overloaded|\b529\b/i;
/** A proxy that says outright the throttle is not the account's usage limit (litellm does). */
const NOT_USAGE_LIMIT_PATTERN = /not (?:your|a|the) usage limit/i;
/** "Context window exceeded" and friends: the conversation is too long, the account is fine. */
const CONTEXT_LENGTH_PATTERN =
  /context[ _-]?(?:window|length|limit)|maximum context|prompt is too long|too many tokens|max(?:imum)?[ _-]tokens/i;

/**
 * Only the message: a stack trace (`Cause.pretty`) names files and line
 * numbers such as `UsageLimits.ts:429:7`, which are not the provider speaking.
 */
function messageOnly(text: string): string {
  const frame = /\n\s+at\s/.exec(text);
  return frame ? text.slice(0, frame.index) : text;
}

/**
 * `"usage"` when the provider's quota or plan is spent, `"transient"` when a
 * server or proxy is throttling for a moment, null for anything else.
 */
export function classifyLimitError(
  message: string | null | undefined,
): "usage" | "transient" | null {
  if (typeof message !== "string") return null;
  const text = messageOnly(message);
  if (CONTEXT_LENGTH_PATTERN.test(text)) return null;
  if (NOT_USAGE_LIMIT_PATTERN.test(text)) return "transient";
  if (USAGE_LIMIT_PATTERN.test(text)) return "usage";
  return TRANSIENT_LIMIT_PATTERN.test(text) ? "transient" : null;
}

/** The provider's usage limit is spent (see `classifyLimitError`). */
export function isLimitError(message: string | null | undefined): message is string {
  return classifyLimitError(message) === "usage";
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
