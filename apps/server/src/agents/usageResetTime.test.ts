// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";

import { parseResetTime } from "./usageResetTime.ts";

const now = Date.parse("2026-09-29T03:30:00Z");
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("parseResetTime", () => {
  it("reads a bare hour in a named zone", () => {
    expect(iso(parseResetTime("You've hit your limit · resets 8pm (UTC)", now))).toBe(
      "2026-09-29T20:00:00.000Z",
    );
  });

  it("rolls a bare time that already passed to tomorrow", () => {
    expect(iso(parseResetTime("Limit reached, resets 2am (UTC)", now))).toBe(
      "2026-09-30T02:00:00.000Z",
    );
  });

  it("reads a month and day", () => {
    expect(iso(parseResetTime("Weekly limit reached. resets Sep 29, 10am (UTC)", now))).toBe(
      "2026-09-29T10:00:00.000Z",
    );
    expect(iso(parseResetTime("resets Oct 3 at 6:30 PM (UTC)", now))).toBe(
      "2026-10-03T18:30:00.000Z",
    );
  });

  it("moves a month and day that fell long ago to next year", () => {
    expect(iso(parseResetTime("resets Jan 3, 9am (UTC)", now))).toBe("2027-01-03T09:00:00.000Z");
  });

  it("honours IANA zones and abbreviations", () => {
    expect(iso(parseResetTime("resets 6pm (America/New_York)", now))).toBe(
      "2026-09-29T22:00:00.000Z",
    );
    expect(iso(parseResetTime("resets 6:00 pm (PST)", now))).toBe("2026-09-30T02:00:00.000Z");
  });

  it("reads relative durations and ISO timestamps", () => {
    expect(iso(parseResetTime("Rate limit exceeded. Try again in 2h 30m.", now))).toBe(
      "2026-09-29T06:00:00.000Z",
    );
    expect(iso(parseResetTime("retry after 45 seconds", now))).toBe("2026-09-29T03:30:45.000Z");
    expect(iso(parseResetTime("quota resets at 2026-10-01T00:00:00Z", now))).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("answers null when no time is named", () => {
    expect(parseResetTime("429 too many requests", now)).toBeNull();
    expect(parseResetTime("resets soon (UTC)", now)).toBeNull();
    expect(parseResetTime("resets 8pm (Not/AZone)", now)).toBeNull();
    expect(parseResetTime("resets 13pm (UTC)", now)).toBeNull();
  });
});
