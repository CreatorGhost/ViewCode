import { msUntilClaudeCacheExpiry } from "@t3tools/shared/claudePromptCache";

/**
 * When the cache banner's clock should next be set to the real time for the thread's
 * latest usage: just after the cache expires, or right away when it already has. The
 * stored `nowMs` can predate the usage when the view stayed mounted across a thread
 * switch, which the assessment reads as "no warning", so an expired cache must not
 * wait for an event to bring the clock forward.
 */
export function claudeCacheClockDelayMs(input: {
  readonly lastUsedAt: string;
  readonly ttlSeconds: number;
  readonly nowMs: number;
}): number {
  const wait = msUntilClaudeCacheExpiry(input);
  return wait <= 0 ? 0 : wait + 250;
}
