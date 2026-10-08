import { describe, expect, it } from "vite-plus/test";

import {
  assessClaudePromptCache,
  claudeInputUsdPerMTok,
  formatClaudeCacheNotice,
  msUntilClaudeCacheExpiry,
  observedClaudeCacheTtlSeconds,
} from "./claudePromptCache.ts";

const lastUsedAt = "2026-10-07T12:00:00.000Z";
const at = (seconds: number) => Date.parse(lastUsedAt) + seconds * 1_000;

describe("observedClaudeCacheTtlSeconds", () => {
  it("reads the lifetime from cache_creation, preferring a 1h write", () => {
    expect(
      observedClaudeCacheTtlSeconds({
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 9_000 },
      }),
    ).toBe(3_600);
    expect(
      observedClaudeCacheTtlSeconds({ cache_creation: { ephemeral_5m_input_tokens: 20 } }),
    ).toBe(300);
  });

  it("is unknown when usage carries no creation breakdown", () => {
    expect(observedClaudeCacheTtlSeconds({ cache_creation_input_tokens: 400 })).toBeUndefined();
    expect(observedClaudeCacheTtlSeconds(undefined)).toBeUndefined();
  });
});

describe("assessClaudePromptCache", () => {
  it("warns once a large context is idle past the assumed 5 minute TTL", () => {
    const warm = assessClaudePromptCache({
      contextTokens: 240_000,
      lastUsedAt,
      nowMs: at(299),
    });
    expect(warm?.expired).toBe(false);
    expect(warm?.warn).toBe(false);

    const cold = assessClaudePromptCache({
      contextTokens: 240_000,
      lastUsedAt,
      model: "claude-opus-5-5",
      nowMs: at(300),
    });
    expect(cold).toMatchObject({ expired: true, warn: true, ttlAssumed: true, ttlSeconds: 300 });
    // 0.24 MTok * $4 * 1.25 cache-write multiplier
    expect(cold?.estimatedUsd).toBeCloseTo(1.2);
  });

  it("uses an observed 1 hour TTL and its 2x write price", () => {
    const stillWarm = assessClaudePromptCache({
      contextTokens: 240_000,
      lastUsedAt,
      ttlSeconds: 3_600,
      nowMs: at(1_800),
    });
    expect(stillWarm?.warn).toBe(false);
    const cold = assessClaudePromptCache({
      contextTokens: 240_000,
      lastUsedAt,
      ttlSeconds: 3_600,
      model: "claude-sonnet-5-5",
      nowMs: at(3_600),
    });
    expect(cold).toMatchObject({ warn: true, ttlAssumed: false });
    expect(cold?.estimatedUsd).toBeCloseTo(0.96);
  });

  it("stays quiet for small contexts and refuses a clock that runs backwards", () => {
    expect(
      assessClaudePromptCache({ contextTokens: 100_000, lastUsedAt, nowMs: at(9_999) })?.warn,
    ).toBe(false);
    expect(assessClaudePromptCache({ contextTokens: 200_000, lastUsedAt, nowMs: at(-5) })).toBe(
      null,
    );
    expect(
      assessClaudePromptCache({ contextTokens: 200_000, lastUsedAt: "nope", nowMs: at(1) }),
    ).toBe(null);
  });
});

describe("cache notice helpers", () => {
  it("prices known model families and leaves unknown ones unpriced", () => {
    expect(claudeInputUsdPerMTok("claude-opus-4-8")).toBe(5);
    expect(claudeInputUsdPerMTok("claude-sonnet-4-6")).toBe(3);
    expect(claudeInputUsdPerMTok("claude-haiku-4-5")).toBe(1);
    expect(claudeInputUsdPerMTok("some-router-model")).toBeUndefined();
  });

  it("says 'likely' only for an assumed TTL", () => {
    const assumed = assessClaudePromptCache({
      contextTokens: 240_400,
      lastUsedAt,
      model: "claude-opus-5-5",
      nowMs: at(600),
    })!;
    expect(formatClaudeCacheNotice(assumed)).toBe(
      "Cache likely expired — resending ~240k tokens uncached (≈ $1.20)",
    );
    const observed = assessClaudePromptCache({
      contextTokens: 150_000,
      lastUsedAt,
      ttlSeconds: 300,
      nowMs: at(600),
    })!;
    expect(formatClaudeCacheNotice(observed)).toBe(
      "Cache expired — resending ~150k tokens uncached",
    );
  });

  it("counts down to expiry", () => {
    expect(msUntilClaudeCacheExpiry({ lastUsedAt, ttlSeconds: 300, nowMs: at(100) })).toBe(200_000);
    expect(msUntilClaudeCacheExpiry({ lastUsedAt, ttlSeconds: 300, nowMs: at(400) })).toBe(0);
  });
});
