import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "~/lib/utils";
import { collectChildAgents, resolveChildAgentStatus } from "../agents/childAgents.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import {
  buildUsageSections,
  formatUsageReset,
  formatUsedPercent,
  peakUsedPercent,
  shouldRefreshUsage,
  type UsageProviderInput,
  type UsageSection,
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

/**
 * The composer's plan-usage ring: a static arc of the lead provider's most-used
 * window that opens the lead's (and other agents' providers') limits before
 * sending.
 */
export const ComposerUsageLimitsPopover = memo(function ComposerUsageLimitsPopover(props: {
  environmentId: EnvironmentId;
  /** The started thread, whose child agents add sections; absent for drafts. */
  threadRef: ScopedThreadRef | null;
  leadInstanceId: ProviderInstanceId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const leadEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.leadInstanceId) ?? null;
  if (!leadEntry) return null;
  const peak = peakUsedPercent(leadEntry.snapshot.usageLimits);
  const tone = peak === null ? null : usageTone(peak);
  const label =
    peak === null
      ? "Plan usage limits"
      : `Plan usage limits, ${formatUsedPercent(peak)} of the busiest window used`;

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
                className={cn(
                  tone === "critical"
                    ? "stroke-destructive"
                    : tone === "warning"
                      ? "stroke-warning"
                      : "stroke-primary",
                )}
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
}) {
  const { environmentId, threadRef, leadEntry, instanceEntries } = props;
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
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col py-1">
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
                <div
                  role="meter"
                  aria-label={`${window.label} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(window.usedPercent)}
                  className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      tone === "critical"
                        ? "bg-destructive"
                        : tone === "warning"
                          ? "bg-warning"
                          : "bg-primary",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}
                  />
                </div>
              </li>
            );
          })}
          {section.resetCredits ? (
            <li className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">Reset credits</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {section.resetCredits.availableCount} available
              </span>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
