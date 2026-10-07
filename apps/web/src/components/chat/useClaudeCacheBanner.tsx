import {
  assessClaudePromptCache,
  formatClaudeCacheNotice,
  msUntilClaudeCacheExpiry,
  CLAUDE_DEFAULT_CACHE_TTL_SECONDS,
} from "@t3tools/shared/claudePromptCache";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { SnowflakeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
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
 * for an idle large Claude thread. It never blocks silently: the first send
 * while the notice is up is held (the draft stays) and the notice offers
 * Send anyway, Compact first and dismiss (for this thread).
 */
export function useClaudeCacheBanner(input: {
  readonly threadId: string | null;
  readonly isClaude: boolean;
  readonly running: boolean;
  readonly model: string | null | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly onCompact: (() => void) | null;
  readonly sendAnyway: () => void;
}): { readonly item: ComposerBannerStackItem | null; readonly holdSend: () => boolean } {
  const { threadId, isClaude, running, model, activities, onCompact, sendAnyway } = input;
  const usage = useMemo(() => (isClaude ? latestUsage(activities) : null), [activities, isClaude]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [dismissedThreads, setDismissedThreads] = useState<ReadonlySet<string>>(new Set());
  const bypassRef = useRef(false);
  const usageKey = threadId && usage ? `${threadId}:${usage.lastUsedAt}` : null;

  useEffect(() => {
    if (!usage || running) return;
    const wait = msUntilClaudeCacheExpiry({
      lastUsedAt: usage.lastUsedAt,
      ttlSeconds: usage.ttlSeconds ?? CLAUDE_DEFAULT_CACHE_TTL_SECONDS,
      nowMs: Date.now(),
    });
    // Already expired: `nowMs` is refreshed by the next render that has new usage.
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), wait + 250);
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
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const held = heldKey === usageKey;

  const holdSend = useCallback(() => {
    if (!visible || bypassRef.current) return false;
    setHeldKey(usageKey);
    return true;
  }, [usageKey, visible]);

  const item = useMemo<ComposerBannerStackItem | null>(() => {
    if (!visible || assessment === null || usageKey === null || threadId === null) return null;
    const dismiss = () => setDismissedThreads((previous) => new Set(previous).add(threadId));
    return {
      id: `claude-cache:${usageKey}`,
      variant: "warning",
      icon: <SnowflakeIcon />,
      title: formatClaudeCacheNotice(assessment),
      description: held ? "Your message was not sent yet." : undefined,
      dismissLabel: "Dismiss for this thread",
      onDismiss: dismiss,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              dismiss();
              bypassRef.current = true;
              try {
                sendAnyway();
              } finally {
                bypassRef.current = false;
              }
            }}
          >
            Send anyway
          </Button>
          {onCompact ? (
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
          ) : null}
        </>
      ),
    };
  }, [assessment, held, onCompact, sendAnyway, threadId, usageKey, visible]);

  return { item, holdSend };
}
