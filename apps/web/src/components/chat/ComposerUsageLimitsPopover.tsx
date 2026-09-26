import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { collectChildAgents, resolveChildAgentStatus } from "../agents/childAgents.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import {
  buildUsageSections,
  formatBankedResets,
  formatContextWindowSummary,
  formatUsageReset,
  formatUsedPercent,
  peakUsedPercent,
  resolveUsageRing,
  shouldRefreshUsage,
  type UsageProviderInput,
  type UsageSection,
  type UsageTone,
  usageRingTone,
  usageTone,
} from "./composerUsageLimits.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function usageProviderInput(entry: ProviderInstanceEntry): UsageProviderInput {
  return {
    instanceId: entry.instanceId,
    driver: entry.driverKind,
    displayName: entry.displayName,
    plan: entry.snapshot.auth.label,
    usageLimits: entry.snapshot.usageLimits,
  };
}

function toneStrokeClassName(tone: UsageTone) {
  return tone === "critical"
    ? "stroke-destructive"
    : tone === "warning"
      ? "stroke-warning"
      : "stroke-primary";
}

function toneFillClassName(tone: UsageTone) {
  return tone === "critical" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-primary";
}

/**
 * The composer's usage ring: a static arc of the thread's context window (or,
 * before one is known, the lead provider's busiest plan window) that opens the
 * context window and plan limits before sending.
 */
export const ComposerUsageLimitsPopover = memo(function ComposerUsageLimitsPopover(props: {
  environmentId: EnvironmentId;
  /** The started thread, whose child agents add sections; absent for drafts. */
  threadRef: ScopedThreadRef | null;
  leadInstanceId: ProviderInstanceId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** The thread's latest context window reading, when known. */
  contextWindow: ContextWindowSnapshot | null;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const leadEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.leadInstanceId) ?? null;
  if (!leadEntry) return null;
  const ring = resolveUsageRing({
    contextPercent: props.contextWindow?.usedPercentage ?? null,
    planPeakPercent: peakUsedPercent(leadEntry.snapshot.usageLimits),
  });
  const peak = ring?.percent ?? null;
  const tone = ring === null ? null : usageRingTone(ring.percent);
  const label =
    ring === null
      ? "Usage"
      : ring.source === "context"
        ? `Usage, context window ${formatUsedPercent(ring.percent)} used`
        : `Usage, ${formatUsedPercent(ring.percent)} of the busiest plan window used`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant="ghost-muted" size="icon-sm" aria-label={label} />}
            />
          }
        >
          <svg viewBox="0 0 22 22" className="size-5.5" aria-hidden="true">
            <circle
              cx="11"
              cy="11"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2"
              className="stroke-foreground/20"
            />
            {peak !== null && peak > 0 ? (
              <circle
                cx="11"
                cy="11"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${(RING_CIRCUMFERENCE * Math.min(peak, 100)) / 100} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 11 11)"
                className={toneStrokeClassName(tone ?? "normal")}
              />
            ) : null}
          </svg>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="center"
        sideOffset={10}
        padding="none"
        variant="floating"
      >
        <UsageLimitsPanel
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          leadEntry={leadEntry}
          instanceEntries={props.instanceEntries}
          contextWindow={props.contextWindow}
          onClose={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
});

/** Mounted only while open, so the thread list and probes are read on demand. */
function UsageLimitsPanel(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  leadEntry: ProviderInstanceEntry;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  contextWindow: ContextWindowSnapshot | null;
  onClose: () => void;
}) {
  const { environmentId, threadRef, leadEntry, instanceEntries, contextWindow } = props;
  const navigate = useNavigate();
  const threads = useThreadShells();
  const agentEntries = useMemo(() => {
    if (!threadRef) return [];
    const entries: ProviderInstanceEntry[] = [];
    for (const agent of collectChildAgents(threads, threadRef)) {
      if (resolveChildAgentStatus(agent.thread) === "failed") continue;
      const entry = instanceEntries.find(
        (candidate) => candidate.instanceId === agent.thread.modelSelection.instanceId,
      );
      if (entry && !entries.includes(entry)) entries.push(entry);
    }
    return entries;
  }, [instanceEntries, threadRef, threads]);

  // Probe once per opening for any provider whose last read is stale.
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState<ReadonlySet<ProviderInstanceId>>(new Set());
  const [openedAt] = useState(() => Date.now());
  const staleInstanceIds = useMemo(
    () =>
      [leadEntry, ...agentEntries]
        .filter((entry) => shouldRefreshUsage(entry.snapshot.usageLimits, openedAt))
        .map((entry) => entry.instanceId),
    [agentEntries, leadEntry, openedAt],
  );
  const probedRef = useRef(false);
  useEffect(() => {
    // Probe once per opening; later reads arrive through the provider snapshots.
    if (probedRef.current || staleInstanceIds.length === 0) return;
    probedRef.current = true;
    setRefreshing(new Set(staleInstanceIds));
    for (const instanceId of staleInstanceIds) {
      void refreshProviders({ environmentId, input: { instanceId } }).finally(() => {
        setRefreshing((current) => {
          const next = new Set(current);
          next.delete(instanceId);
          return next;
        });
      });
    }
  }, [environmentId, refreshProviders, staleInstanceIds]);

  const sections = buildUsageSections({
    lead: usageProviderInput(leadEntry),
    agentProviders: agentEntries.map(usageProviderInput),
    refreshingInstanceIds: refreshing,
  });
  // Reset times read from the moment the panel opened; a ticking clock would repaint it.
  const now = openedAt;
  const entryById = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));

  return (
    <div className="flex w-82.5 max-w-[calc(100vw-2rem)] flex-col pt-3 pb-1">
      <div className="flex items-center justify-between gap-2 px-4">
        <span className="font-semibold text-muted-foreground text-sm">Usage</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Open usage"
                onClick={() => {
                  props.onClose();
                  void navigate({ to: "/usage" });
                }}
              />
            }
          >
            <ArrowUpRightIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open usage</TooltipPopup>
        </Tooltip>
      </div>
      {contextWindow ? (
        <>
          <section className="flex flex-col gap-1.5 px-4 py-3" aria-label="Context window">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">Context window</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatContextWindowSummary(
                  contextWindow.usedTokens,
                  contextWindow.maxTokens ?? null,
                )}
              </span>
            </div>
            {contextWindow.usedPercentage !== null ? (
              <UsageBar
                label="Context window used"
                percent={contextWindow.usedPercentage}
                tone={usageRingTone(contextWindow.usedPercentage)}
              />
            ) : null}
          </section>
          <div className="mx-4 border-border/70 border-t" />
        </>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 ? <div className="mx-4 border-border/70 border-t" /> : null}
          <UsageSectionView
            section={section}
            entry={entryById.get(section.instanceId) ?? null}
            refreshing={refreshing.has(section.instanceId)}
            now={now}
          />
        </Fragment>
      ))}
    </div>
  );
}

function UsageSectionView(props: {
  section: UsageSection;
  entry: ProviderInstanceEntry | null;
  refreshing: boolean;
  now: number;
}) {
  const { section, entry } = props;
  return (
    <section className="flex flex-col gap-3 px-4 py-3" aria-label={section.title}>
      <div className="flex items-center gap-2">
        {entry ? (
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            accentColor={entry.accentColor}
            className="size-4"
            iconClassName="size-4"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold text-sm">{section.title}</span>
          <span className="truncate text-muted-foreground text-xs">{section.subtitle}</span>
        </div>
        {props.refreshing && section.status === "ready" ? (
          <span className="shrink-0 text-muted-foreground text-xs">Checking…</span>
        ) : null}
      </div>
      {section.status === "checking" ? (
        <span className="text-muted-foreground text-xs">Checking…</span>
      ) : section.status === "message" ? (
        <span className="text-muted-foreground text-xs">{section.message}</span>
      ) : (
        <ul className="flex flex-col gap-3">
          {section.windows.map((window) => {
            const tone = usageTone(window.usedPercent);
            const reset = formatUsageReset(window.resetsAt, props.now);
            return (
              <li key={window.id} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{window.label}</span>
                  {reset ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{reset}</span>
                  ) : null}
                  <span className="w-9 shrink-0 text-right font-medium tabular-nums">
                    {formatUsedPercent(window.usedPercent)}
                  </span>
                </div>
                <UsageBar label={`${window.label} used`} percent={window.usedPercent} tone={tone} />
              </li>
            );
          })}
          {section.resetCredits ? (
            <li className="flex items-baseline gap-2 border-border/70 border-t pt-3 text-xs">
              <span className="min-w-0 flex-1 truncate">Banked resets</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatBankedResets(section.resetCredits)}
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function UsageBar(props: { label: string; percent: number; tone: UsageTone }) {
  const percent = Math.max(0, Math.min(100, props.percent));
  return (
    <div
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
    >
      <div
        className={cn("h-full rounded-full", toneFillClassName(props.tone))}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
