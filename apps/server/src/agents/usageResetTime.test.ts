// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";

import { isLimitError } from "@t3tools/shared/usageLimit";

import {
  freshUsageWindows,
  limitKindOf,
  mergeRateLimitSignal,
  parseResetTime,
  pickResetTime,
  rateLimitSignalReset,
  selectSpentWindowReset,
} from "./usageResetTime.ts";

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

  it("reads a Unix timestamp after a bar, in seconds or milliseconds", () => {
    expect(iso(parseResetTime("usage limit reached|1757865600", now))).toBe(
      "2025-09-14T16:00:00.000Z",
    );
    expect(iso(parseResetTime("usage limit reached | 1757865600000", now))).toBe(
      "2025-09-14T16:00:00.000Z",
    );
  });

  it("reads 'resets at 3:30 pm' and 'hit your limit' messages", () => {
    expect(iso(parseResetTime("You've hit your limit. It resets at 3:30 pm (UTC)", now))).toBe(
      "2026-09-29T15:30:00.000Z",
    );
    const local = parseResetTime("You've hit your limit · resets 3:30 pm", now)!;
    expect(new Date(local).getHours()).toBe(15);
    expect(new Date(local).getMinutes()).toBe(30);
    expect(local).toBeGreaterThan(now);
  });

  it("only reads messages that isLimitError accepts", () => {
    for (const message of [
      "usage limit reached|1757865600",
      "You've hit your limit · resets at 3:30 pm",
      "5-hour limit reached ∙ resets 3pm",
    ]) {
      expect(isLimitError(message), message).toBe(true);
      expect(parseResetTime(message, now), message).not.toBeNull();
    }
  });

  it("answers null when no time is named", () => {
    expect(parseResetTime("429 too many requests", now)).toBeNull();
    expect(parseResetTime("resets soon (UTC)", now)).toBeNull();
    expect(parseResetTime("resets 8pm (Not/AZone)", now)).toBeNull();
    expect(parseResetTime("resets 13pm (UTC)", now)).toBeNull();
  });
});

describe("reset time sources", () => {
  const future = "2026-09-29T09:00:00.000Z";
  const signal = (resetsAt: number | null, windows: string[] = []) => ({ resetsAt, windows });

  it("reads the provider's rejected-window signal in seconds or milliseconds", () => {
    expect(rateLimitSignalReset({ status: "rejected", resetsAt: 1757865600 })).toBe(1757865600000);
    expect(rateLimitSignalReset({ status: "rejected", resetsAtSeconds: 1757865600 })).toBe(
      1757865600000,
    );
    expect(rateLimitSignalReset({ status: "rejected", resetsAt: 1757865600000 })).toBe(
      1757865600000,
    );
    expect(rateLimitSignalReset({ status: "rejected" })).toBeNull();
    expect(
      rateLimitSignalReset({ status: "allowed_warning", resetsAt: 1757865600 }),
    ).toBeUndefined();
    expect(rateLimitSignalReset("nope")).toBeUndefined();
  });

  it("lets a later signal with a time beat an earlier one without, and collects rejected windows", () => {
    const first = mergeRateLimitSignal(undefined, {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 5,
    });
    expect(first).toEqual(signal(5000, ["five_hour"]));
    const second = mergeRateLimitSignal(first, { status: "rejected", rateLimitType: "seven_day" });
    expect(second).toEqual(signal(5000, ["five_hour", "seven_day"]));
    expect(mergeRateLimitSignal(second, { status: "allowed" })).toBe(second);
    expect(mergeRateLimitSignal(undefined, { status: "rejected" })).toEqual(signal(null));
  });

  it("takes the most-used window with a future reset, only when it is at least 95% used", () => {
    const windows = [
      { usedPercent: 97, resetsAt: future },
      { usedPercent: 99, resetsAt: "2026-09-29T01:00:00.000Z" },
      { usedPercent: 96 },
    ];
    // The 99% window already reset, so the 97% one is the most-used with a future reset.
    expect(iso(selectSpentWindowReset(windows, now))).toBe(future);
    expect(selectSpentWindowReset([{ usedPercent: 94, resetsAt: future }], now)).toBeNull();
    expect(selectSpentWindowReset([], now)).toBeNull();
  });

  it("prefers the window the provider said was rejected over the most-used one", () => {
    const weekly = "2026-10-02T00:00:00.000Z";
    const windows = [
      { id: "five_hour", usedPercent: 100, resetsAt: future },
      { id: "seven_day", usedPercent: 80, resetsAt: weekly },
    ];
    expect(iso(selectSpentWindowReset(windows, now, ["seven_day"]))).toBe(weekly);
    expect(iso(selectSpentWindowReset(windows, now))).toBe(future);
  });

  it("ignores a usage reading that is stale, failed or unsupported", () => {
    const windows = [{ usedPercent: 100, resetsAt: future }];
    const at = (ms: number) => new Date(ms).toISOString();
    expect(freshUsageWindows({ checkedAt: at(now - 60_000), windows }, now)).toBe(windows);
    expect(freshUsageWindows({ checkedAt: at(now - 60 * 60_000), windows }, now)).toEqual([]);
    expect(
      freshUsageWindows({ checkedAt: at(now), windows, unavailable: { reason: "x" } }, now),
    ).toEqual([]);
    expect(freshUsageWindows(undefined, now)).toEqual([]);
  });

  it("prefers the recorded signal, then the error text, then the windows", () => {
    const windows = [{ usedPercent: 100, resetsAt: future }];
    const text = "resets 8pm (UTC)";
    const recorded = Date.parse("2026-09-29T05:00:00Z");
    expect(iso(pickResetTime({ recorded: signal(recorded), text, windows, nowMs: now }))).toBe(
      iso(recorded),
    );
    expect(iso(pickResetTime({ recorded: signal(null), text, windows, nowMs: now }))).toBe(
      "2026-09-29T20:00:00.000Z",
    );
    expect(iso(pickResetTime({ recorded: undefined, text: "429", windows, nowMs: now }))).toBe(
      future,
    );
    expect(
      pickResetTime({ recorded: signal(null), text: "429", windows: [], nowMs: now }),
    ).toBeNull();
  });

  it("skips a source whose time is already past and falls through to the next", () => {
    const windows = [{ usedPercent: 100, resetsAt: future }];
    const past = now - 60 * 60_000;
    expect(iso(pickResetTime({ recorded: signal(past), text: "", windows, nowMs: now }))).toBe(
      future,
    );
    // A month and day kept up to a day old by the clock parser is past, too.
    expect(
      iso(
        pickResetTime({
          recorded: undefined,
          text: "Weekly limit reached. resets Sep 28, 10pm (UTC)",
          windows,
          nowMs: now,
        }),
      ),
    ).toBe(future);
    expect(pickResetTime({ recorded: signal(past), text: "", windows: [], nowMs: now })).toBeNull();
  });
});

describe("limitKindOf", () => {
  it("tells a usage limit from a transient throttle", () => {
    expect(limitKindOf("You've hit your limit · resets 8pm (UTC)", now)).toEqual({
      kind: "usage",
    });
    expect(
      limitKindOf(
        "API Error: Server is temporarily limiting requests (not your usage limit) · litellm.RateLimitError",
        now,
      ),
    ).toEqual({ kind: "transient", retryAt: null });
    expect(limitKindOf("Failed to read file with 429 lines", now)).toBeNull();
  });

  it("treats a short retry hint as a throttle, even in usage-limit wording", () => {
    expect(limitKindOf("Rate limit reached. Please try again in 1.2s.", now)).toEqual({
      kind: "transient",
      retryAt: now + 1200,
    });
    expect(limitKindOf("usage limit reached, retry after 20 seconds", now)).toEqual({
      kind: "transient",
      retryAt: now + 20_000,
    });
    expect(limitKindOf("usage limit reached, try again in 2h 30m", now)).toEqual({
      kind: "usage",
    });
    // A rejected window signalled during the turn is the usage limit, hint or not.
    expect(
      limitKindOf("usage limit reached, retry after 20 seconds", now, {
        resetsAt: null,
        windows: ["five_hour"],
      }),
    ).toEqual({ kind: "usage" });
  });
});
