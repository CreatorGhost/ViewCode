/**
 * Claude prompt-cache expiry estimate for the composer notice.
 *
 * Anthropic keeps a prompt prefix cached for 5 minutes after it was last used
 * (1 hour when the request asked for the extended TTL). Sending to a large
 * Claude thread after that re-writes the whole prefix at cache-write prices.
 * This module turns the usage ViewCode already records (the thread's latest
 * context-window row) into "has the cache likely expired, and roughly what
 * does resending cost". It never blocks a send; the UI only informs.
 */

export const CLAUDE_CACHE_WARNING_MIN_TOKENS = 100_000;
export const CLAUDE_DEFAULT_CACHE_TTL_SECONDS = 300;
export const CLAUDE_EXTENDED_CACHE_TTL_SECONDS = 3_600;

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * The cache lifetime a Claude API `usage` object proves, from its
 * `cache_creation` breakdown. A 1h write keeps the long prefix alive even when
 * a 5m tail was written too. Undefined when the usage does not say.
 */
export function observedClaudeCacheTtlSeconds(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const creation = (usage as Record<string, unknown>).cache_creation;
  if (!creation || typeof creation !== "object") return undefined;
  const fields = creation as Record<string, unknown>;
  if ((tokenCount(fields.ephemeral_1h_input_tokens) ?? 0) > 0) {
    return CLAUDE_EXTENDED_CACHE_TTL_SECONDS;
  }
  if ((tokenCount(fields.ephemeral_5m_input_tokens) ?? 0) > 0) {
    return CLAUDE_DEFAULT_CACHE_TTL_SECONDS;
  }
  return undefined;
}

/** USD per million input tokens, matched on the model id; most specific first. */
const INPUT_USD_PER_MTOK: ReadonlyArray<readonly [RegExp, number]> = [
  [/fable|mythos/, 10],
  [/opus-5-5|opus-5\.5/, 4],
  [/opus/, 5],
  [/sonnet-4-[0-6]|sonnet-4\.[0-6]|sonnet-4(?!-?\d)/, 3],
  [/sonnet/, 2],
  [/haiku/, 1],
];

/** List input price for a Claude model id, or undefined for unknown ids. */
export function claudeInputUsdPerMTok(model: string | null | undefined): number | undefined {
  const id = model?.toLowerCase() ?? "";
  if (id.length === 0) return undefined;
  return INPUT_USD_PER_MTOK.find(([pattern]) => pattern.test(id))?.[1];
}

export interface ClaudeCacheAssessment {
  /** True when the notice should show: large context and a likely-expired cache. */
  readonly warn: boolean;
  readonly expired: boolean;
  /** The TTL was assumed (5 minutes), not observed in usage. */
  readonly ttlAssumed: boolean;
  readonly ttlSeconds: number;
  readonly idleSeconds: number;
  readonly contextTokens: number;
  /** Approximate cost of re-writing the prefix to the cache; undefined for unknown models. */
  readonly estimatedUsd: number | undefined;
}

/**
 * Assess a Claude thread's prompt cache from its last usage report.
 * Returns null when there is nothing to assess (no usage, bad clock).
 */
export function assessClaudePromptCache(input: {
  readonly contextTokens: number | null | undefined;
  /** When the last turn's usage was recorded (ISO), i.e. the cache's last use. */
  readonly lastUsedAt: string | null | undefined;
  readonly ttlSeconds?: number | null | undefined;
  readonly model?: string | null | undefined;
  readonly nowMs: number;
}): ClaudeCacheAssessment | null {
  const contextTokens = tokenCount(input.contextTokens);
  const lastUsedMs = Date.parse(input.lastUsedAt ?? "");
  if (contextTokens === undefined || !Number.isFinite(lastUsedMs) || !Number.isFinite(input.nowMs))
    return null;
  if (input.nowMs < lastUsedMs) return null;
  const observedTtl = tokenCount(input.ttlSeconds);
  const ttlAssumed = observedTtl === undefined || observedTtl === 0;
  const ttlSeconds = ttlAssumed ? CLAUDE_DEFAULT_CACHE_TTL_SECONDS : observedTtl;
  const idleSeconds = Math.floor((input.nowMs - lastUsedMs) / 1_000);
  const expired = idleSeconds >= ttlSeconds;
  const price = claudeInputUsdPerMTok(input.model);
  // Re-writing costs 1.25x input for a 5 minute cache, 2x for 1 hour.
  const writeMultiplier = ttlSeconds >= CLAUDE_EXTENDED_CACHE_TTL_SECONDS ? 2 : 1.25;
  return {
    warn: expired && contextTokens > CLAUDE_CACHE_WARNING_MIN_TOKENS,
    expired,
    ttlAssumed,
    ttlSeconds,
    idleSeconds,
    contextTokens,
    estimatedUsd:
      price === undefined ? undefined : (contextTokens / 1_000_000) * price * writeMultiplier,
  };
}

/** Milliseconds until the cache likely expires (0 when already expired). */
export function msUntilClaudeCacheExpiry(input: {
  readonly lastUsedAt: string;
  readonly ttlSeconds: number;
  readonly nowMs: number;
}): number {
  const lastUsedMs = Date.parse(input.lastUsedAt);
  if (!Number.isFinite(lastUsedMs)) return 0;
  return Math.max(0, lastUsedMs + input.ttlSeconds * 1_000 - input.nowMs);
}

function formatUsd(value: number): string {
  if (value < 0.01) return "<$0.01";
  return `$${value < 10 ? value.toFixed(2) : Math.round(value).toString()}`;
}

/** "Cache likely expired — resending ~240k tokens uncached (≈ $1.20)". */
export function formatClaudeCacheNotice(assessment: ClaudeCacheAssessment): string {
  const thousands = Math.round(assessment.contextTokens / 1_000);
  const cost =
    assessment.estimatedUsd === undefined ? "" : ` (≈ ${formatUsd(assessment.estimatedUsd)})`;
  return `Cache ${assessment.ttlAssumed ? "likely " : ""}expired — resending ~${thousands}k tokens uncached${cost}`;
}
