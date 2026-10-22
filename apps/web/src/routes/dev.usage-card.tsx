import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { ComposerUsageLimitsPopover } from "~/components/chat/ComposerUsageLimitsPopover";
import { Button } from "~/components/ui/button";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import type { ProviderInstanceEntry } from "~/providerInstances";

/**
 * Development preview of the composer's usage ring and card, with a simulated compaction.
 * Not in production builds.
 */
export const Route = createFileRoute("/dev/usage-card")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: UsageCardPreview,
});

const NOW = Date.now();
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const limitWindow = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  resetsInHours: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  resetsAt: inHours(resetsInHours),
  windowDurationMins: kind === "session" ? 300 : 7 * 24 * 60,
});

const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "me@example.com", label: "Claude Max 20x" },
  checkedAt: new Date(NOW).toISOString(),
  models: [],
  slashCommands: [{ name: "compact", description: "Compact the conversation" }],
  skills: [],
  reportsContextWindow: true,
  usageLimits: {
    checkedAt: new Date(NOW).toISOString(),
    windows: [
      limitWindow("five_hour", "session", "Session", 68, 2.8),
      limitWindow("seven_day", "weekly", "Weekly", 24, 2 * 24 + 9),
    ],
  },
};

const entry: ProviderInstanceEntry = {
  instanceId: snapshot.instanceId,
  driverKind: snapshot.driver,
  displayName: "Claude",
  enabled: true,
  installed: true,
  status: "ready",
  isDefault: true,
  isAvailable: true,
  snapshot,
  models: [],
};

const contextAt = (usedTokens: number): ContextWindowSnapshot => ({
  usedTokens,
  totalProcessedTokens: 2_410_000,
  maxTokens: 1_000_000,
  remainingTokens: 1_000_000 - usedTokens,
  usedPercentage: usedTokens / 10_000,
  remainingPercentage: 100 - usedTokens / 10_000,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  autoCompactThreshold: 967_000,
  cost: null,
  updatedAt: new Date(NOW).toISOString(),
});

function UsageCardPreview() {
  const [used, setUsed] = useState(604_100);
  const [compacting, setCompacting] = useState(false);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!compacting) return;
    const timer = window.setTimeout(() => {
      setUsed(76_700);
      setCompacting(false);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [compacting]);
  return (
    <div className="flex min-h-screen flex-col items-center justify-end gap-6 bg-background p-10">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="xs" onClick={() => setUsed(604_100)}>
          Reset
        </Button>
        <Button variant="outline" size="xs" onClick={() => setUsed(930_000)}>
          Near limit
        </Button>
        <Button variant="outline" size="xs" onClick={() => setLive((value) => !value)}>
          {live ? "Turn off the live ring" : "Turn on the live ring"}
        </Button>
      </div>
      <div
        data-chat-composer-main-surface="true"
        className="relative isolate flex h-14 w-144 max-w-full items-center justify-end gap-1 rounded-3xl border border-border bg-popover px-3"
      >
        {live ? <ComposerSurface.LiveRing /> : null}
        <ComposerUsageLimitsPopover
          environmentId={EnvironmentId.make("env-local")}
          leadInstanceId={entry.instanceId}
          instanceEntries={[entry]}
          contextWindow={contextAt(used)}
          onCompact={() => setCompacting(true)}
          compactDisabled={compacting}
          compactDisabledReason={null}
          compacting={compacting}
          threadKey="preview"
        />
      </div>
    </div>
  );
}
