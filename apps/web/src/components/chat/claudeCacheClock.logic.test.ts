import { assessClaudePromptCache } from "@t3tools/shared/claudePromptCache";
import { describe, expect, it } from "vite-plus/test";

import { claudeCacheClockDelayMs } from "./claudeCacheClock.logic";

const MOUNTED_AT = Date.parse("2026-01-01T10:00:00.000Z");

describe("claudeCacheClockDelayMs", () => {
  it("schedules an immediate clock refresh for usage recorded after mount that has since expired", () => {
    // The view mounted at 10:00, another thread's usage landed at 10:10, and the
    // user switches to it at 10:30: the stored clock still reads 10:00.
    const lastUsedAt = "2026-01-01T10:10:00.000Z";
    const realNow = Date.parse("2026-01-01T10:30:00.000Z");
    const usage = { contextTokens: 240_000, lastUsedAt, ttlSeconds: 300 };

    expect(assessClaudePromptCache({ ...usage, nowMs: MOUNTED_AT })).toBeNull();
    const delay = claudeCacheClockDelayMs({ lastUsedAt, ttlSeconds: 300, nowMs: realNow });
    expect(delay).toBe(0);
    expect(assessClaudePromptCache({ ...usage, nowMs: realNow })?.warn).toBe(true);
  });

  it("waits for expiry, plus a margin, while the cache is still warm", () => {
    const delay = claudeCacheClockDelayMs({
      lastUsedAt: "2026-01-01T10:00:00.000Z",
      ttlSeconds: 300,
      nowMs: MOUNTED_AT + 60_000,
    });
    expect(delay).toBe(240_000 + 250);
  });
});
