// @effect-diagnostics globalDate:off -- Pure calendar arithmetic on epoch milliseconds; Intl and Date are the only zone-aware tools.
/**
 * Reads when a usage limit resets out of a provider's error text, e.g.
 * "You've hit your limit · resets 8pm (UTC)", "resets Sep 29, 10am (UTC)",
 * "try again in 2h 30m" or an ISO timestamp. Providers report this only as
 * prose, so the parser is tolerant and answers null when it is not sure.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FIXED_ZONES: Readonly<Record<string, number>> = {
  utc: 0,
  gmt: 0,
  z: 0,
  pst: -8,
  pdt: -7,
  mst: -7,
  mdt: -6,
  cst: -6,
  cdt: -5,
  est: -5,
  edt: -4,
};
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type Zone = { readonly fixedOffsetMs: number } | { readonly iana: string } | null;

function resolveZone(label: string | undefined): Zone | undefined {
  if (label === undefined) return null;
  const key = label.trim().toLowerCase();
  const fixed = FIXED_ZONES[key];
  if (fixed !== undefined) return { fixedOffsetMs: fixed * HOUR_MS };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: label.trim() });
    return { iana: label.trim() };
  } catch {
    return undefined;
  }
}

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function ianaOffsetMs(epochMs: number, timeZone: string): number {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    values.year!,
    values.month! - 1,
    values.day!,
    values.hour!,
    values.minute!,
    values.second!,
  );
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** The calendar date `nowMs` falls on in the zone (month is 0-based). */
function dateIn(nowMs: number, zone: Zone): Parts {
  if (zone === null) {
    const local = new Date(nowMs);
    return { year: local.getFullYear(), month: local.getMonth(), day: local.getDate() };
  }
  const offset = "iana" in zone ? ianaOffsetMs(nowMs, zone.iana) : zone.fixedOffsetMs;
  const shifted = new Date(nowMs + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function wallClockToEpoch(date: Parts, hour: number, minute: number, zone: Zone): number {
  if (zone === null) return new Date(date.year, date.month, date.day, hour, minute).getTime();
  const guess = Date.UTC(date.year, date.month, date.day, hour, minute);
  if ("fixedOffsetMs" in zone) return guess - zone.fixedOffsetMs;
  const first = guess - ianaOffsetMs(guess, zone.iana);
  return guess - ianaOffsetMs(first, zone.iana);
}

const DURATION_UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^d/i, DAY_MS],
  [/^h/i, HOUR_MS],
  [/^m/i, 60_000],
  [/^s/i, 1000],
];

function parseRelative(text: string, nowMs: number): number | null {
  const anchor =
    /(?:try again|retry|resets?|available|wait|come back)[^.\n]{0,40}?\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(
      text,
    );
  if (!anchor) return null;
  let total = 0;
  for (const match of anchor[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = DURATION_UNIT_MS.find(([pattern]) => pattern.test(match[2]!));
    if (!unit) return null;
    total += Number(match[1]) * unit[1];
  }
  return total > 0 ? nowMs + total : null;
}

function parseClock(text: string, nowMs: number): number | null {
  const keyword = /\bresets?\b(?:\s+(?:at|on))?/i.exec(text);
  if (!keyword) return null;
  const rest = text.slice(
    keyword.index + keyword[0].length,
    keyword.index + keyword[0].length + 90,
  );
  const pattern =
    /^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?[,\s]*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?|(\d{1,2}):(\d{2}))(?![\d:])\s*(?:\(([^)]+)\)|\b(utc|gmt))?/i;
  const match = pattern.exec(rest);
  if (!match) return null;
  const [
    ,
    monthName,
    dayText,
    yearText,
    hour12,
    minute12,
    meridiem,
    hour24,
    minute24,
    zoneParen,
    zoneBare,
  ] = match;
  let hour: number;
  let minute: number;
  if (hour12 !== undefined) {
    hour = Number(hour12);
    minute = Number(minute12 ?? 0);
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem!.toLowerCase() === "p" ? 12 : 0);
  } else {
    hour = Number(hour24);
    minute = Number(minute24);
    if (hour > 23) return null;
  }
  if (minute > 59) return null;
  const zone = resolveZone(zoneParen ?? zoneBare);
  if (zone === undefined) return null;
  const today = dateIn(nowMs, zone);
  if (monthName === undefined) {
    const candidate = wallClockToEpoch(today, hour, minute, zone);
    if (candidate > nowMs) return candidate;
    // A bare time that already passed today means tomorrow.
    return wallClockToEpoch({ ...today, day: today.day + 1 }, hour, minute, zone);
  }
  const month = MONTHS.indexOf(monthName.toLowerCase());
  const day = Number(dayText);
  if (day < 1 || day > 31) return null;
  const year = yearText === undefined ? today.year : Number(yearText);
  let candidate = wallClockToEpoch({ year, month, day }, hour, minute, zone);
  // "Jan 3" seen in December is next year; one that only just passed stays due.
  if (yearText === undefined && candidate < nowMs - DAY_MS) {
    candidate = wallClockToEpoch({ year: year + 1, month, day }, hour, minute, zone);
  }
  return candidate;
}

/** Epoch milliseconds of the reset the text names, or null when it names none. */
export function parseResetTime(text: string, nowMs: number): number | null {
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(
    text,
  );
  if (iso) {
    const parsed = Date.parse(iso[1]!);
    if (Number.isFinite(parsed)) return parsed;
  }
  const relative = parseRelative(text, nowMs);
  if (relative !== null) return relative;
  const clock = parseClock(text, nowMs);
  return clock !== null && Number.isFinite(clock) ? clock : null;
}
