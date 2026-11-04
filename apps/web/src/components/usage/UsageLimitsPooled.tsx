import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  type LimitAccount,
  type LimitPace,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  buildRailUsageCardRows,
  railPlanLabel,
  railTokenRows,
  usageProviderForDriver,
} from "@t3tools/shared/usagePace";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { AlertTriangleIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { RailRingTone } from "../rail/appRail.logic";
import { ResetCreditDialog, resetCreditsSummary, useResetCredit } from "./UsageLimits";
import { TONE_FILL, TokenRowList, type TokenUsageWindows } from "./UsageWindowRow";

/** `formatResetsIn` reads "resets in 4h" mid-sentence; a row's trailing label starts a phrase. */
function resetsInLabel(window: ServerProviderUsageWindow | null | undefined, now: number) {
  const text = window ? formatResetsIn(window, now) : null;
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

/** The pooled pace as the rail's tone: ahead of the window is running out early. */
const POOL_PACE_TONE: Record<LimitPace, RailRingTone> = {
  ahead: "critical",
  on: "low",
  under: "healthy",
};

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? "Using…" : "Use reset"}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One account's share of a window, drawn as the thin track the rail card and Synara use:
 * remaining quota in its health colour, a tick where an even pace would be by now. The
 * confirm is a sibling of the popover, not a child: dialogs stack under popovers, and the
 * popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  window,
  reset,
  now,
  index,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly index: number;
}) {
  const [open, setOpen] = useState(false);
  const row = buildRailUsageCardRows([window], now)[0];
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const showMarker = row?.markerPercent !== null && remaining > 0 && remaining < 100;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            style={{ gridColumn: index, gridRow: 1 }}
            aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
            className="relative h-2 min-w-0 cursor-pointer overflow-hidden rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-ring/60"
          />
        }
      >
        {remaining > 0 ? (
          <div
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              TONE_FILL[row?.tone ?? "healthy"],
            )}
            style={{ width: `${remaining}%` }}
          />
        ) : null}
        {showMarker && row ? (
          <div
            aria-hidden
            className="absolute inset-y-0 flex w-2 -translate-x-1/2 items-center justify-center bg-card"
            style={{ left: `${row.markerPercent}%` }}
          >
            <span className={cn("h-full w-0.5 rounded-full", TONE_FILL[row.paceTone])} />
          </div>
        ) : null}
      </PopoverTrigger>
      {account.redeem ? (
        <RedeemableSegmentPopup
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeemAt={account.redeem}
          closePopover={() => setOpen(false)}
        />
      ) : (
        <PopoverPopup side="top" sideOffset={6}>
          <SegmentPopover
            account={account}
            window={window}
            reset={reset}
            now={now}
            redeem={null}
            onRedeem={() => {}}
          />
        </PopoverPopup>
      )}
    </Popover>
  );
}

/** Under a pooled window, who each track belongs to: account, what is left, reset and banked credits. */
function LegendRow({
  account,
  window,
  now,
  index,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly now: number;
  readonly index: number;
}) {
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <span
      style={{ gridColumn: index, gridRow: 2 }}
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
    >
      <AccountAvatar account={account} className="size-4" />
      <AccountName account={account} className="min-w-0 truncate" />
      <span className="shrink-0 font-medium text-foreground">{remaining}%</span>
      {resetsIn ? <span className="ms-auto shrink-0">{resetsInLabel(window, now)}</span> : null}
      {credits ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground">
          <TicketIcon className="size-3" aria-hidden />
          {credits}
          <span className="sr-only"> reset {credits === 1 ? "credit" : "credits"} banked</span>
        </span>
      ) : null}
    </span>
  );
}

function RedeemableSegmentPopup({
  account,
  window,
  reset,
  now,
  redeemAt,
  closePopover,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly closePopover: () => void;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <PopoverPopup side="top" sideOffset={6}>
        <SegmentPopover
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeem={redeem}
          onRedeem={() => {
            closePopover();
            redeem.setConfirming(true);
          }}
        />
      </PopoverPopup>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? "Using reset credit…" : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function PoolBar({ pool, now }: { readonly pool: LimitPoolWindow; readonly now: number }) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  const pooled = pool.columns.length > 1;
  return (
    <div
      className="grid gap-x-3 gap-y-1.5"
      style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
    >
      {pool.columns.map((member, position) =>
        member.window ? (
          <Fragment key={member.account.key}>
            <PoolSegment
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              now={now}
              index={position + 1}
            />
            {pooled ? (
              <LegendRow
                account={member.account}
                window={member.window}
                now={now}
                index={position + 1}
              />
            ) : null}
          </Fragment>
        ) : null,
      )}
    </div>
  );
}

/**
 * One window as Synara's Usage settings draw it: label with a pace dot against the reset, the
 * track, then what is left against the run-out. A pooled window lists its accounts under it.
 */
function PoolWindowRow({
  pool,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}) {
  const single = pool.columns.length === 1 ? pool.columns[0]?.window : undefined;
  const row = single ? buildRailUsageCardRows([single], now)[0] : undefined;
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const resetText = row
    ? row.reset
    : nextRefill
      ? `${resetsInLabel(nextRefill.member.window, now) ?? ""} · +${nextRefill.restoresPercent}%`
      : null;
  const paceTone = row ? row.paceTone : pool.pace ? POOL_PACE_TONE[pool.pace] : null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <span className="truncate">{label ?? pool.label}</span>
          {paceTone ? (
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[paceTone])}
            />
          ) : null}
        </span>
        {resetText ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{resetText}</span>
        ) : null}
      </div>
      <PoolBar pool={pool} now={now} />
      <div className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
        <span className="text-foreground">{pool.remainingPercent}% left</span>
        {row?.paceEta ? (
          <span className="text-muted-foreground">
            {row.paceAmount ? `${row.paceAmount} · ` : ""}
            {row.paceEta}
          </span>
        ) : null}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/**
 * One card per provider, its windows stacked inside, then 24h / 7d / 30d tokens, as Synara's
 * Usage settings draw them.
 */
function PoolSection({
  pool,
  now,
  tokenUsage,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly tokenUsage: TokenUsageWindows | undefined;
}) {
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const plans = new Set(pool.accounts.map((account) => account.plan).filter(Boolean));
  const shared = plans.size === 1 ? [...plans][0] : undefined;
  const plan = shared ? railPlanLabel(shared, label) : null;
  // The email stays behind the popover's reveal, so a shared screen does not show it: the
  // instance's own name when it was renamed, otherwise it is just the default account.
  const only = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
  const accountLabel = only
    ? only.displayName && only.displayName.toLowerCase() !== label.toLowerCase()
      ? only.displayName
      : "Default account"
    : `${pool.accounts.length} accounts`;
  const provider = usageProviderForDriver(pool.driver);
  const tokenRows = provider && tokenUsage ? railTokenRows(provider, tokenUsage) : [];
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <h2 className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/60">
            <ProviderInstanceIcon
              driverKind={pool.driver}
              displayName={label}
              indicatorBackground="var(--card)"
              className="size-4"
              iconClassName="size-4 text-foreground/80"
            />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-foreground">{label}</span>
            <span className="truncate text-xs text-muted-foreground">{accountLabel}</span>
          </span>
        </span>
        {plan ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {plan}
          </span>
        ) : null}
      </h2>
      <div className="flex flex-col gap-4">
        {windows.map((window) => {
          const details =
            pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
          return (
            <PoolWindowRow
              key={`${window.kind}:${window.id}`}
              pool={window}
              now={now}
              label={details?.label}
              description={details?.description}
            />
          );
        })}
      </div>
      {tokenRows.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 text-xs">
          <TokenRowList rows={tokenRows} />
        </div>
      ) : null}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
  tokenUsage,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
  /** One 24h / 7d / 30d read shared by every card (`useTokenUsageWindows`), never one per provider. */
  readonly tokenUsage?: TokenUsageWindows;
}) {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool, index) => (
        <Fragment key={pool.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <PoolSection pool={pool} now={now} tokenUsage={tokenUsage} />
        </Fragment>
      ))}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
