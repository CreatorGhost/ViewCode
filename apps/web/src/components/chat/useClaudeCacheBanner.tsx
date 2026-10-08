import {
  assessClaudePromptCache,
  formatClaudeCacheNotice,
  CLAUDE_DEFAULT_CACHE_TTL_SECONDS,
} from "@t3tools/shared/claudePromptCache";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { SnowflakeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/button";
import { claudeCacheClockDelayMs } from "./claudeCacheClock.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

interface LatestUsage {
  readonly contextTokens: number;
  readonly lastUsedAt: string;
  readonly ttlSeconds: number | undefined;
}

function latestUsage(activities: ReadonlyArray<OrchestrationThreadActivity>): LatestUsage | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const payload = activity.payload as Record<string, unknown> | null;
    const used = payload?.usedTokens;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    const ttl = payload?.promptCacheTtlSeconds;
    return {
      contextTokens: used,
      lastUsedAt: activity.createdAt,
      ttlSeconds: typeof ttl === "number" ? ttl : undefined,
    };
  }
  return null;
}

/**
 * "Cache likely expired — resending ~240k tokens uncached" above the composer
 * for an idle large Claude thread. It only informs: sending is never held,
 * so Enter and the send button always send. It offers Compact first and
 * dismiss (for this thread).
 */
export function useClaudeCacheBanner(input: {
  readonly threadId: string | null;
  readonly isClaude: boolean;
  readonly running: boolean;
  readonly model: string | null | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onCompact: (() => void) | null;
}): { readonly item: ComposerBannerStackItem | null } {
  const { threadId, isClaude, running, model, activities, onCompact } = input;
  const usage = useMemo(() => (isClaude ? latestUsage(activities) : null), [activities, isClaude]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissedThreads, setDismissedThreads] = useState<ReadonlySet<string>>(new Set());
  const usageKey = threadId && usage ? `${threadId}:${usage.lastUsedAt}` : null;

  useEffect(() => {
    if (!usage || running) return;
    const delay = claudeCacheClockDelayMs({
      lastUsedAt: usage.lastUsedAt,
      ttlSeconds: usage.ttlSeconds ?? CLAUDE_DEFAULT_CACHE_TTL_SECONDS,
      nowMs: Date.now(),
    });
    // A zero delay brings `nowMs` forward for an already-expired cache; it can predate
    // this usage after a thread switch, and the assessment then never warns.
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [running, usage]);

  const assessment = useMemo(
    () =>
      usage === null || running
        ? null
        : assessClaudePromptCache({
            contextTokens: usage.contextTokens,
            lastUsedAt: usage.lastUsedAt,
            ttlSeconds: usage.ttlSeconds,
            model,
            nowMs,
          }),
    [model, nowMs, running, usage],
  );
  const visible = assessment?.warn === true && threadId !== null && !dismissedThreads.has(threadId);

  const item = useMemo<ComposerBannerStackItem | null>(() => {
    if (!visible || assessment === null || usageKey === null || threadId === null) return null;
    const dismiss = () => setDismissedThreads((previous) => new Set(previous).add(threadId));
    return {
      id: `claude-cache:${usageKey}`,
      variant: "warning",
      icon: <SnowflakeIcon />,
      title: formatClaudeCacheNotice(assessment),
      dismissLabel: "Dismiss for this thread",
      onDismiss: dismiss,
      actions: onCompact ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            dismiss();
            onCompact();
          }}
        >
          Compact first
        </Button>
      ) : undefined,
    };
  }, [assessment, onCompact, threadId, usageKey, visible]);

  return { item };
}
