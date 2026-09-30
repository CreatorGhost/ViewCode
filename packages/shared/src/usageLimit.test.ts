// @effect-diagnostics globalDate:off -- Builds local wall-clock times to check zone-relative wording.
import { describe, expect, it } from "vite-plus/test";

import {
  classifyLimitError,
  formatResumeAt,
  formatResumeTime,
  isLimitError,
} from "./usageLimit.ts";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const NOW = at(30, 12);

describe("formatResumeTime", () => {
  it("words the time by how far away the day is", () => {
    expect(formatResumeTime(at(30, 15, 31), NOW, "en-US")).toBe("3:31 PM");
    expect(formatResumeTime(at(31, 9), NOW, "en-US")).toBe("tomorrow at 9:00 AM");
  });

  it("names the weekday within a week and dates anything later", () => {
    // NOW is Wednesday 30 September 2026.
    expect(formatResumeTime(at(33, 9), NOW, "en-US")).toBe("Saturday at 9:00 AM");
    expect(formatResumeTime(at(36, 9), NOW, "en-US")).toBe("Tuesday at 9:00 AM");
    expect(formatResumeTime(at(37, 9), NOW, "en-US")).toBe("Oct 7, 9:00 AM");
  });

  it("words the time to follow a verb", () => {
    expect(formatResumeAt(at(30, 15, 31), NOW, "en-US")).toBe("at 3:31 PM");
    expect(formatResumeAt(at(31, 9), NOW, "en-US")).toBe("tomorrow at 9:00 AM");
    expect(formatResumeAt(at(33, 9), NOW, "en-US")).toBe("Saturday at 9:00 AM");
    expect(formatResumeAt(at(37, 9), NOW, "en-US")).toBe("on Oct 7, 9:00 AM");
  });

  it("accepts ISO strings", () => {
    expect(formatResumeTime(new Date(at(30, 18)).toISOString(), NOW, "en-US")).toBe("6:00 PM");
  });
});

describe("isLimitError", () => {
  it("recognises the messages the reset parser understands", () => {
    for (const message of [
      "usage limit reached|1757865600",
      "You've hit your limit · resets 3:30 pm",
      "You are out of extra usage",
    ]) {
      expect(isLimitError(message), message).toBe(true);
    }
    expect(isLimitError("Context limit reached")).toBe(false);
  });

  it("recognises the providers' own usage-limit wording", () => {
    for (const message of [
      "Claude usage limit reached. Send the message again once the limit resets.",
      "You've hit your usage limit. Upgrade to Pro or try again in 4 days 3 hours.",
      "Weekly limit reached · resets Oct 3, 9am",
      "Your credit balance is too low to access the API.",
      "insufficient_quota: You exceeded your current quota",
    ]) {
      expect(classifyLimitError(message), message).toBe("usage");
    }
  });

  it("treats a proxy or server throttle as transient, not as the usage limit", () => {
    for (const message of [
      "API Error: Server is temporarily limiting requests (not your usage limit) · litellm.RateLimitError: rate_limit_error. Please try again later",
      "429 Too Many Requests",
      "Rate limit reached for gpt-5 on tokens per min (TPM). Please try again in 1.2s.",
      "Claude API is overloaded (529). Try again shortly.",
    ]) {
      expect(classifyLimitError(message), message).toBe("transient");
      expect(isLimitError(message), message).toBe(false);
    }
  });

  it("ignores unrelated numbers, words and stack traces", () => {
    for (const message of [
      "Failed to read file with 429 lines",
      "Buy more credits in settings",
      "quota.json not found",
      "Error: spawn failed\n    at run (/app/src/UsageLimits.ts:429:7)\n    at usage limit reached (x.ts:1:1)",
    ]) {
      expect(classifyLimitError(message), message).toBeNull();
    }
  });
});
