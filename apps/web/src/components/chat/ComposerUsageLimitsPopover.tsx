import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { memo, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { useUsageRefreshOnOpen } from "./useUsageRefreshOnOpen";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";
import {
  buildUsageSections,
  contextSegments,
  formatBankedResets,
  formatContextHeadline,
  formatTokenCount,
  formatUsageReset,
  formatUsedPercent,
  planUsageWindow,
  resolveUsageRing,
  shortPlanName,
  type UsageProviderInput,
  type UsageSection,
  type UsageTone,
  usageRingTone,
  usageTone,
  usageWindowTitle,
} from "./composerUsageLimits.logic";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
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
 * The composer's usage ring: a thin arc of the thread's context window (or,
 * before one is known, the lead provider's plan usage) that opens a card with
 * the context breakdown, the plan limits and a Compact action.
 */
export const ComposerUsageLimitsPopover = memo(function ComposerUsageLimitsPopover(props: {
  environmentId: EnvironmentId;
  leadInstanceId: ProviderInstanceId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** The thread's latest context window reading, when known. */
  contextWindow: ContextWindowSnapshot | null;
  /** Absent when the lead provider has no manual compaction. */
  onCompact?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  /** A compaction the thread is running right now, from this card or `/compact`. */
  compacting: boolean;
  /** Identifies the thread the readings belong to, so a switch resets the card. */
  threadKey: string;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const leadEntry =
    props.instanceEntries.find((entry) => entry.instanceId === props.leadInstanceId) ?? null;
  if (!leadEntry) return null;
  const planWindow = planUsageWindow(leadEntry.snapshot.usageLimits, leadEntry.driverKind);
  const ring = resolveUsageRing({
    contextPercent: props.contextWindow?.usedPercentage ?? null,
    planPercent: planWindow?.usedPercent ?? null,
  });
  const peak = ring?.percent ?? null;
  const tone = ring === null ? null : usageRingTone(ring.percent);
  const label =
    ring === null
      ? "Context and usage"
      : ring.source === "context" && props.contextWindow
        ? `Context ${formatUsedPercent(ring.percent)} · ${formatContextHeadline(props.contextWindow.usedTokens, props.contextWindow.maxTokens ?? null)}`
        : `${planWindow ? usageWindowTitle(planWindow) : "Plan usage"} ${formatUsedPercent(ring.percent)}`;

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
              className="stroke-foreground/14"
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
                  "transition-[stroke-dasharray,stroke] duration-500 ease-out motion-reduce:transition-none",
                  toneStrokeClassName(tone ?? "normal"),
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
        {open ? (
          <UsageLimitsPanel
            key={`${props.environmentId}:${leadEntry.instanceId}:${props.threadKey}`}
            environmentId={props.environmentId}
            leadEntry={leadEntry}
            contextWindow={props.contextWindow}
            onCompact={props.onCompact}
            compactDisabled={props.compactDisabled}
            compactDisabledReason={props.compactDisabledReason}
            compacting={props.compacting}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});

/** Mounted only while open; opening uses cached readings and refreshes stale ones. */
function UsageLimitsPanel(props: {
  environmentId: EnvironmentId;
  leadEntry: ProviderInstanceEntry;
  contextWindow: ContextWindowSnapshot | null;
  onCompact: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  compacting: boolean;
  onClose: () => void;
}) {
  const { environmentId, leadEntry, contextWindow, compacting } = props;
  const navigate = useNavigate();
  const instanceEntries = [leadEntry];
  const { refreshing, openedAt, error } = useUsageRefreshOnOpen(environmentId, instanceEntries);
  const section = buildUsageSections({
    lead: usageProviderInput(leadEntry),
    agentProviders: [],
    refreshingInstanceIds: refreshing,
  })[0]!;
  // Reset times read from the moment the panel opened; a ticking clock would repaint it.
  const now = openedAt;

  // A compaction started while this card is open counts as done only once a
  // lower reading lands, and the freed amount is fixed at that first reading: the
  // compacting flag also drops when a run fails or is stopped, and later turns
  // would otherwise erode the number.
  const [compactionRun, setCompactionRun] = useState<{
    compacting: boolean;
    usedBefore: number | null;
    freed: number | null;
  }>({ compacting: false, usedBefore: null, freed: null });
  if (compacting !== compactionRun.compacting) {
    setCompactionRun({
      compacting,
      usedBefore: compacting ? (contextWindow?.usedTokens ?? null) : compactionRun.usedBefore,
      freed: null,
    });
  } else if (
    !compacting &&
    compactionRun.usedBefore !== null &&
    contextWindow &&
    contextWindow.usedTokens < compactionRun.usedBefore
  ) {
    setCompactionRun({
      compacting: false,
      usedBefore: null,
      freed: compactionRun.usedBefore - contextWindow.usedTokens,
    });
  }
  const freedTokens = compacting ? null : compactionRun.freed;
  const compacted = freedTokens !== null;

  const segments = contextWindow
    ? contextSegments({
        usedTokens: contextWindow.usedTokens,
        maxTokens: contextWindow.maxTokens ?? null,
        autoCompactThreshold: contextWindow.autoCompactThreshold ?? null,
        compactsAutomatically: contextWindow.compactsAutomatically ?? null,
      })
    : null;
  const maxTokens = contextWindow?.maxTokens ?? null;
  const processedTokens = contextWindow?.totalProcessedTokens ?? null;
  const contextPercent = contextWindow?.usedPercentage ?? null;
  const contextTone = usageRingTone(contextPercent ?? 0);
  const autoCompactNote =
    segments === null
      ? null
      : segments.untilAutoCompact !== null
        ? segments.untilAutoCompact > 0
          ? `${formatTokenCount(segments.untilAutoCompact)} until auto-compact`
          : "At the auto-compact threshold"
        : contextWindow?.compactsAutomatically
          ? "Compacts automatically when needed"
          : null;
  const footerNote = compacting
    ? "Summarizing messages"
    : freedTokens !== null
      ? `Freed ${formatTokenCount(freedTokens)} tokens`
      : autoCompactNote;
  const showFooter = props.onCompact !== undefined || footerNote !== null;

  return (
    <div className="flex max-h-[min(70vh,var(--available-height))] w-85 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto">
      {error ? (
        <p role="status" className="px-4 pt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {contextWindow && segments ? (
        <section className="flex flex-col gap-2.5 px-4 pt-3.5 pb-3.5" aria-label="Context window">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex items-baseline gap-1.5 font-medium">
              Context
              {contextPercent !== null ? (
                <span className="text-muted-foreground tabular-nums">
                  {formatUsedPercent(contextPercent)}
                </span>
              ) : null}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatContextHeadline(contextWindow.usedTokens, maxTokens)}
            </span>
          </div>
          {maxTokens !== null && maxTokens > 0 ? (
            <ContextBar
              maxTokens={maxTokens}
              segments={segments}
              tone={contextTone}
              compacting={compacting}
            />
          ) : null}
          <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs">
            <LegendItem
              label="Used"
              value={formatTokenCount(segments.used)}
              swatchClassName={toneFillClassName(contextTone)}
            />
            {segments.free !== null ? (
              <LegendItem
                label="Free"
                value={formatTokenCount(segments.free)}
                swatchClassName="bg-foreground/8"
              />
            ) : null}
            {segments.reserved !== null ? (
              <LegendItem
                label="Reserved"
                value={formatTokenCount(segments.reserved)}
                swatchClassName="bg-foreground/24"
                hint="Kept free so compacting has room to run"
              />
            ) : null}
            {contextWindow.cost ? (
              <LegendItem label="Cost" value={formatContextWindowCost(contextWindow.cost)} />
            ) : processedTokens !== null && processedTokens > 0 ? (
              <LegendItem label="Processed" value={formatTokenCount(processedTokens)} />
            ) : null}
          </dl>
        </section>
      ) : leadEntry.snapshot.reportsContextWindow !== true ? (
        // Say so rather than leave a gap: a missing row reads as broken, and the
        // account usage below is a different measure.
        <section className="flex flex-col gap-1 px-4 pt-3.5 pb-3" aria-label="Context window">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-medium">Context</span>
            <span className="text-muted-foreground">Not reported</span>
          </div>
          <p className="text-muted-foreground text-xs">
            {leadEntry.displayName} does not report how much of the context window this thread uses.
          </p>
        </section>
      ) : null}
      <div className="border-border/70 border-t" />
      <UsageSectionView
        section={section}
        entry={leadEntry}
        refreshing={refreshing.has(section.instanceId)}
        now={now}
        onOpenUsage={() => {
          props.onClose();
          void navigate({ to: "/usage" });
        }}
      />
      {showFooter ? (
        <>
          <div className="border-border/70 border-t" />
          <footer className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex min-h-7 items-center justify-between gap-3">
              <span
                role="status"
                className={cn(
                  "flex min-w-0 items-center gap-1.5 text-xs",
                  compacted ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {compacted ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
                ) : null}
                <span className="truncate">{footerNote}</span>
              </span>
              {props.onCompact ? (
                <Button
                  variant="primary-soft"
                  size="xs"
                  disabled={props.compactDisabled || compacting || compacted}
                  onClick={props.onCompact}
                >
                  {compacted ? "Compacted" : "Compact now"}
                </Button>
              ) : null}
            </div>
            {props.onCompact &&
            props.compactDisabled &&
            !compacting &&
            !compacted &&
            props.compactDisabledReason ? (
              <p className="text-muted-foreground text-2xs">{props.compactDisabledReason}</p>
            ) : null}
          </footer>
        </>
      ) : null}
    </div>
  );
}

/**
 * Used, free and reserved as adjoining blocks of one track. Each block keeps a
 * sliver once it is non-zero so a near-empty thread still reads as started.
 */
function ContextBar(props: {
  maxTokens: number;
  segments: { used: number; free: number | null; reserved: number | null };
  tone: UsageTone;
  compacting: boolean;
}) {
  const { maxTokens, segments } = props;
  const percent = (tokens: number) => Math.max(0, Math.min(100, (tokens / maxTokens) * 100));
  const blocks = [
    {
      key: "used",
      tokens: segments.used,
      className: toneFillClassName(props.tone),
    },
    { key: "free", tokens: segments.free ?? 0, className: "bg-foreground/8" },
    { key: "reserved", tokens: segments.reserved ?? 0, className: "bg-foreground/24" },
  ].filter((block) => block.tokens > 0);
  return (
    <div
      role="meter"
      aria-label="Context window used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent(segments.used))}
      className="flex h-2 w-full gap-0.75"
    >
      {blocks.map((block) => (
        <div
          key={block.key}
          data-context-segment={block.key}
          data-compacting={block.key === "used" && props.compacting ? "" : undefined}
          className={cn(
            "h-full min-w-1 overflow-hidden rounded-xs transition-[flex-basis] duration-500 ease-out motion-reduce:transition-none",
            block.className,
          )}
          style={{ flexBasis: `${percent(block.tokens)}%` }}
        />
      ))}
    </div>
  );
}

function LegendItem(props: {
  label: string;
  value: string;
  swatchClassName?: string;
  hint?: string;
}) {
  const row = (
    <div className="flex items-baseline gap-1.5">
      {props.swatchClassName ? (
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 self-center rounded-xs", props.swatchClassName)}
        />
      ) : null}
      <dt className="min-w-0 flex-1 truncate text-muted-foreground">{props.label}</dt>
      <dd className="shrink-0 font-medium tabular-nums">{props.value}</dd>
    </div>
  );
  if (!props.hint) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="right">{props.hint}</TooltipPopup>
    </Tooltip>
  );
}

/** `Claude Max 20x` rather than `Claude · Claude Max 20x`; `Codex · ChatGPT Pro` when the plan names no provider. */
function providerTitle(displayName: string, plan: string | undefined): string {
  if (!plan) return displayName;
  const short = shortPlanName(plan);
  return short.toLowerCase().startsWith(displayName.toLowerCase())
    ? short
    : `${displayName} · ${short}`;
}

function UsageSectionView(props: {
  section: UsageSection;
  entry: ProviderInstanceEntry;
  refreshing: boolean;
  now: number;
  onOpenUsage: () => void;
}) {
  const { section, entry } = props;
  return (
    <section
      className="flex flex-col gap-3 px-4 py-3"
      aria-label={providerTitle(entry.displayName, entry.snapshot.auth.label)}
    >
      <div className="flex items-center gap-2">
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          className="size-4"
          iconClassName="size-4"
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {providerTitle(entry.displayName, entry.snapshot.auth.label)}
        </span>
        {props.refreshing && section.status === "ready" ? (
          <span className="shrink-0 text-muted-foreground text-2xs">Checking…</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Open usage"
                onClick={props.onOpenUsage}
              />
            }
          >
            <ArrowUpRightIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">Open usage</TooltipPopup>
        </Tooltip>
      </div>
      {section.status === "ready" && section.message ? (
        <span className="text-muted-foreground text-xs">{section.message}</span>
      ) : null}
      {section.status === "checking" ? (
        <span className="text-muted-foreground text-xs">Checking…</span>
      ) : section.status === "message" ? (
        <span className="text-muted-foreground text-xs">{section.message}</span>
      ) : (
        <ul className="flex flex-col gap-3">
          {section.windows.map((window) => {
            const tone = usageTone(window.usedPercent);
            const reset = formatUsageReset(window.resetsAt, props.now);
            const title = usageWindowTitle(window);
            return (
              <li key={window.id} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate font-medium">{title}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatUsedPercent(window.usedPercent)}
                    </span>
                  </span>
                  {reset ? (
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {reset}
                    </span>
                  ) : null}
                </div>
                <UsageBar label={`${title} used`} percent={window.usedPercent} tone={tone} />
              </li>
            );
          })}
        </ul>
      )}
      {section.resetCredits ? (
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="min-w-0 text-muted-foreground">Banked reset credits</span>
          <span className="shrink-0 font-medium tabular-nums">
            {formatBankedResets(section.resetCredits)}
          </span>
        </div>
      ) : section.resetCreditsUnavailableReason ? (
        <p className="text-muted-foreground text-2xs">{section.resetCreditsUnavailableReason}</p>
      ) : null}
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
      className="h-2 w-full overflow-hidden rounded-full bg-foreground/8"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
          toneFillClassName(props.tone),
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
