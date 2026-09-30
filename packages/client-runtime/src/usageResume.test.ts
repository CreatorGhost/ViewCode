// @effect-diagnostics globalDate:off -- Builds local wall-clock times to check zone-relative wording.
import { USAGE_RESUME_ACTIVITY_KIND } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveUsageResumeNotice,
  formatUsageResumeTime,
  usageLimitNotificationBody,
} from "./usageResume.ts";

// Local wall-clock times, so the wording does not depend on the machine's zone.
const localIso = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).toISOString();
const NOW = new Date(2026, 8, 29, 12).getTime();
const activity = (payload: unknown, createdAt = "2026-09-29T12:00:00Z") => ({
  kind: USAGE_RESUME_ACTIVITY_KIND,
  payload,
  createdAt,
});
const idle = { status: "error" } as const;

describe("resume wording", () => {
  it("formats times for today, tomorrow, this week and later", () => {
    expect(formatUsageResumeTime(localIso(29, 15, 31), NOW, "en-US")).toBe("3:31 PM");
    expect(formatUsageResumeTime(localIso(30, 9), NOW, "en-US")).toBe("tomorrow at 9:00 AM");
    expect(formatUsageResumeTime(localIso(29 + 3, 9), NOW, "en-US")).toBe("Friday at 9:00 AM");
    expect(formatUsageResumeTime(localIso(29 + 9, 9), NOW, "en-US")).toBe("Oct 8, 9:00 AM");
  });

  it("words the desktop notification, with or without a scheduled resume", () => {
    expect(usageLimitNotificationBody(localIso(29, 15, 31), NOW, "en-US")).toBe(
      "Usage limit reached. Continuing at 3:31 PM.",
    );
    expect(usageLimitNotificationBody(localIso(30, 9), NOW, "en-US")).toBe(
      "Usage limit reached. Continuing tomorrow at 9:00 AM.",
    );
    expect(usageLimitNotificationBody(undefined, NOW)).toBe(
      "Usage limit reached. Send a message to continue.",
    );
  });
});

describe("deriveUsageResumeNotice", () => {
  it("offers Cancel while a resume is scheduled", () => {
    const notice = deriveUsageResumeNotice({
      activities: [activity({ state: "scheduled", resumeAt: localIso(29, 18, 1) })],
      session: idle,
      latestTurn: null,
      nowMs: NOW,
      locale: "en-US",
    });
    expect(notice?.state).toBe("scheduled");
    expect(notice?.canCancel).toBe(true);
    expect(notice?.text).toBe("Out of usage · resumes automatically at 6:01 PM");
  });

  it("says when the reset time is unknown or automatic resume is off", () => {
    const unknown = deriveUsageResumeNotice({
      activities: [activity({ state: "unknown" })],
      session: idle,
      latestTurn: null,
      nowMs: NOW,
    });
    expect(unknown?.text).toBe("Out of usage; ViewCode can't tell when it resets.");
    const off = deriveUsageResumeNotice({
      activities: [activity({ state: "reset-known", resetsAt: localIso(30, 9) })],
      session: idle,
      latestTurn: null,
      nowMs: NOW,
    });
    expect(off?.canCancel).toBe(false);
    expect(off?.text).toBe("Out of usage · resets tomorrow at 9:00 AM");
  });

  it("hides once the latest state is settled or the thread moved on", () => {
    const scheduled = activity({ state: "scheduled", resumeAt: "2026-09-29T18:01:00Z" });
    const base = { session: idle, latestTurn: null, nowMs: NOW } as const;
    expect(
      deriveUsageResumeNotice({
        ...base,
        activities: [scheduled, activity({ state: "cancelled" })],
      }),
    ).toBeNull();
    expect(
      deriveUsageResumeNotice({
        ...base,
        activities: [scheduled],
        session: { status: "running" },
      }),
    ).toBeNull();
    expect(
      deriveUsageResumeNotice({
        ...base,
        activities: [scheduled],
        latestTurn: { requestedAt: "2026-09-29T12:30:00Z" },
      }),
    ).toBeNull();
    expect(deriveUsageResumeNotice({ ...base, activities: [] })).toBeNull();
  });
});
