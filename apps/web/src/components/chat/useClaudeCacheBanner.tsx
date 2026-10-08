import {
  assessClaudePromptCache,
  formatClaudeCacheNotice,
  CLAUDE_DEFAULT_CACHE_TTL_SECONDS,
} from "@t3tools/shared/claudePromptCache";
import { SnowflakeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { Button } from "../ui/button";
import { claudeCacheClockDelayMs } from "./claudeCacheClock.logic";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * "Cache likely expired — resending ~240k tokens uncached" above the composer
 * for an idle large Claude thread. It only informs: sending is never held,
 * so Enter and the send button always send. It offers Compact first and
 * dismiss (for this thread). `contextWindow` is the current session's usage
 * (`deriveLatestContextWindowSnapshot`), so a previous provider's usage from
 * before a handoff never drives it.
 */
export function useClaudeCacheBanner(input: {
  readonly threadId: string | null;
  readonly isClaude: boolean;
  readonly running: boolean;
  readonly model: string | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly onCompact: (() => void) | null;
}): { readonly item: ComposerBannerStackItem | null } {
  const { threadId, isClaude, running, model, contextWindow, onCompact } = input;
  const usage = useMemo(
    () =>
      isClaude && contextWindow
        ? {
            contextTokens: contextWindow.usedTokens,
            lastUsedAt: contextWindow.updatedAt,
            ttlSeconds: contextWindow.promptCacheTtlSeconds ?? undefined,
          }
        : null,
    [contextWindow, isClaude],
  );
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
