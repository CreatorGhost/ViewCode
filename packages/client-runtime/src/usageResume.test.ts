import { USAGE_RESUME_ACTIVITY_KIND } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveUsageResumeNotice } from "./usageResume.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const activity = (payload: unknown, createdAt = "2026-09-29T12:00:00Z") => ({
  kind: USAGE_RESUME_ACTIVITY_KIND,
  payload,
  createdAt,
});
const idle = { status: "error" } as const;

describe("deriveUsageResumeNotice", () => {
  it("offers Cancel while a resume is scheduled", () => {
    const notice = deriveUsageResumeNotice({
      activities: [activity({ state: "scheduled", resumeAt: "2026-09-29T18:01:00Z" })],
      session: idle,
      latestTurn: null,
      nowMs: NOW,
      locale: "en-US",
    });
    expect(notice?.state).toBe("scheduled");
    expect(notice?.canCancel).toBe(true);
    expect(notice?.text).toMatch(/^Out of usage · resumes automatically at /);
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
      activities: [activity({ state: "reset-known", resetsAt: "2026-09-29T18:00:00Z" })],
      session: idle,
      latestTurn: null,
      nowMs: NOW,
    });
    expect(off?.canCancel).toBe(false);
    expect(off?.text).toMatch(/^Out of usage · resets at /);
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
