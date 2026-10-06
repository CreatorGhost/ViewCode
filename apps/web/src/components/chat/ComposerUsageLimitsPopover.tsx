import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, GaugeIcon } from "lucide-react";
import { Fragment, memo, useState } from "react";

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
  buildAccountUsageSections,
  formatBankedResets,
  formatContextWindowSummary,
  formatUsageReset,
  formatUsedPercent,
  planUsageWindow,
  resolveUsageRing,
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
 * before one is known, the lead provider's plan usage) that opens the
 * context window and plan limits before sending.
 */
export const ComposerUsageLimitsPopover = memo(function ComposerUsageLimitsPopover(props: {
  environmentId: EnvironmentId;
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
  const planWindow = planUsageWindow(leadEntry.snapshot.usageLimits, leadEntry.driverKind);
  const ring = resolveUsageRing({
    contextPercent: props.contextWindow?.usedPercentage ?? null,
    planPercent: planWindow?.usedPercent ?? null,
  });
  const peak = ring?.percent ?? null;
  const tone = ring === null ? null : usageRingTone(ring.percent);
  const label =
    ring === null
      ? "Usage"
      : ring.source === "context"
        ? `Usage, context window ${formatUsedPercent(ring.percent)} used`
        : `Usage, ${planWindow?.label ?? "plan"} ${formatUsedPercent(ring.percent)} used`;

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
        {open ? (
          <UsageLimitsPanel
            key={`${props.environmentId}:${leadEntry.instanceId}`}
            environmentId={props.environmentId}
            instanceEntries={[leadEntry]}
            scope="selected"
            contextWindow={props.contextWindow}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});

/** All enabled accounts in this chat's environment, separate from its context window. */
export const AccountUsagePopover = memo(function AccountUsagePopover(props: {
  environmentId: EnvironmentId;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}) {
  const [open, setOpen] = useState(false);
  const entries = props.instanceEntries.filter((entry) => entry.enabled && entry.isAvailable);
  const headlines = entries
    .flatMap((entry) => {
      const window = planUsageWindow(entry.snapshot.usageLimits, entry.driverKind);
      return window
        ? [{ ...window, providerName: entry.displayName, instanceId: entry.instanceId }]
        : [];
    })
    .toSorted((a, b) => b.usedPercent - a.usedPercent)
    .slice(0, 2);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant="outline" size="sm" aria-label="Account usage" />}
            />
          }
        >
          <GaugeIcon aria-hidden="true" className="size-4" />
          <span className="flex w-4 flex-col gap-1" aria-hidden="true">
            {[0, 1].map((index) => {
              const percent = headlines[index]?.usedPercent ?? 0;
              return (
                <span key={index} className="h-1 overflow-hidden rounded-full bg-foreground/15">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      toneFillClassName(usageTone(percent)),
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                  />
                </span>
              );
            })}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <div className="flex flex-col gap-1">
            <span>Account usage and resets</span>
            {headlines.map((window) => (
              <span key={window.instanceId}>
                {window.providerName}: {formatUsedPercent(window.usedPercent)} used
              </span>
            ))}
          </div>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={10}
        padding="none"
        variant="floating"
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
      >
        {open ? (
          <UsageLimitsPanel
            key={props.environmentId}
            environmentId={props.environmentId}
            instanceEntries={entries}
            scope="accounts"
            contextWindow={null}
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
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  scope: "selected" | "accounts";
  contextWindow: ContextWindowSnapshot | null;
  onClose: () => void;
}) {
  const { environmentId, instanceEntries, contextWindow } = props;
  const navigate = useNavigate();
  const { refreshing, openedAt, error } = useUsageRefreshOnOpen(environmentId, instanceEntries);
  const sections =
    props.scope === "accounts"
      ? buildAccountUsageSections(instanceEntries.map(usageProviderInput), refreshing)
      : instanceEntries[0]
        ? buildUsageSections({
            lead: usageProviderInput(instanceEntries[0]),
            agentProviders: [],
            refreshingInstanceIds: refreshing,
          }).map((section) => ({ ...section, title: instanceEntries[0]!.displayName }))
        : [];
  // Reset times read from the moment the panel opened; a ticking clock would repaint it.
  const now = openedAt;
  const entryById = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));

  return (
    <div className="flex max-h-[min(70vh,var(--available-height))] w-82.5 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto pt-3 pb-1">
      <div className="flex items-center justify-between gap-2 px-4">
        <span className="font-semibold text-muted-foreground text-sm">
          {props.scope === "accounts" ? "Account usage" : "Context and usage"}
        </span>
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
      {error ? (
        <p role="status" className="px-4 pt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {sections.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          No enabled providers in this environment.
        </p>
      ) : null}
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
      ) : props.scope === "selected" &&
        instanceEntries[0] &&
        instanceEntries[0].snapshot.reportsContextWindow !== true ? (
        // Say so rather than leave a gap under "Context and usage": a missing
        // row reads as broken, and account usage below is a different measure.
        <>
          <section className="flex flex-col gap-1 px-4 py-3" aria-label="Context window">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium">Context window</span>
              <span className="shrink-0 text-muted-foreground">Not reported</span>
            </div>
            <p className="text-muted-foreground text-xs">
              {instanceEntries[0].displayName} does not report how much of the context window this
              thread uses.
            </p>
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
        </ul>
      )}
      {section.resetCredits ? (
        <div className="flex items-baseline gap-2 border-border/70 border-t pt-3 text-xs">
          <span className="min-w-0 flex-1">Banked reset credits</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatBankedResets(section.resetCredits)}
          </span>
        </div>
      ) : section.resetCreditsUnavailableReason ? (
        <p className="text-xs text-muted-foreground">{section.resetCreditsUnavailableReason}</p>
      ) : section.driver === "claudeAgent" ? (
        <p className="text-xs text-muted-foreground">
          Reset credits are not reported by this Claude connection.
        </p>
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
      className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
    >
      <div
        className={cn("h-full rounded-full", toneFillClassName(props.tone))}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
