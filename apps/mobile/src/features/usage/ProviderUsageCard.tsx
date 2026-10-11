import { useNavigation } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import {
  buildRailUsageCardRows,
  railPlanLabel,
  railTokenRows,
  usageProviderForDriver,
} from "@t3tools/shared/usagePace";
import {
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  formatResetsIn,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useId, useMemo } from "react";
import { Pressable, View } from "react-native";
import { Defs, Path, Pattern, Rect, Svg } from "react-native-svg";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useUsage } from "../../state/usage";
import { ResetCredits } from "./UsageLimitsSection";
import { UsageWindowRow } from "./UsageWindowRow";
import { useProviderColors } from "./usageProviders";
import { limitDriverLabel, tokenUsageWindows } from "./usageScreenModel";

type ProviderColors = ReturnType<typeof useProviderColors>;

/** The chart's series colour for a driver; drivers the chart does not know use the neutral one. */
function driverColor(colors: ProviderColors, driver: string): string {
  switch (driver) {
    case "claudeAgent":
      return colors.claude;
    case "grok":
    case "cursor":
    case "opencode":
    case "antigravity":
      return colors[driver];
    default:
      return colors.codex;
  }
}

function accountName(account: LimitAccount) {
  if (account.displayName) return account.displayName;
  if (!account.email) return limitDriverLabel(account.driver);
  const [local = "", domain = ""] = account.email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "Account";
}

/** The spent share comes back at reset. SVG keeps the hatching static on both platforms. */
function AccountSegment({
  remaining,
  color,
  pending,
}: {
  readonly remaining: number;
  readonly color: string;
  readonly pending: boolean;
}) {
  const patternId = useId().replace(/:/g, "");
  return (
    <Svg width="100%" height="100%" accessible={false}>
      <Defs>
        <Pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse">
          <Path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke={color} strokeWidth={1} opacity={0.22} />
        </Pattern>
      </Defs>
      {pending ? (
        <Rect
          x={`${remaining}%`}
          width={`${100 - remaining}%`}
          height="100%"
          fill={`url(#${patternId})`}
        />
      ) : null}
      <Rect width={`${remaining}%`} height="100%" fill={color} opacity={0.35} />
    </Svg>
  );
}

function PoolWindow({
  pool,
  color,
  now,
  environmentIds,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
  readonly label?: string;
  readonly description?: string;
}) {
  const navigation = useNavigation();
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const openAccount = (account: LimitAccount) =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsUsageAccount",
        params: {
          accountKey: account.key,
          windowId: pool.id,
          windowKind: pool.kind,
          environmentIds,
          now,
        },
      },
    });
  // A lone segment needs no number to tell it apart.
  const numbered = pool.columns.length > 1;
  return (
    <View className="gap-3">
      <View className="gap-0.5">
        <Text className="text-sm font-t3-medium text-foreground">{label ?? pool.label}</Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {pool.remainingPercent}% left across {pool.columns.length} accounts
        </Text>
      </View>
      {description ? <Text className="text-xs text-foreground-muted">{description}</Text> : null}
      {nextRefill ? (
        <Text className="text-xs tabular-nums text-foreground-muted">
          ↻ +{nextRefill.restoresPercent}%{" "}
          {nextRefill.at <= now ? "now" : `in ${formatDuration(nextRefill.at - now)}`}
        </Text>
      ) : null}
      <View className="flex-row gap-1">
        {pool.columns.map(({ account, window }, index) => {
          if (!window) return <View key={account.key} className="h-7 min-w-0 flex-1" />;
          return (
            <Pressable
              key={account.key}
              accessibilityRole="button"
              accessibilityLabel={`Segment ${index + 1}, ${accountName(account)}, ${remainingPercent(window)}% left`}
              accessibilityHint="Show account details"
              onPress={() => openAccount(account)}
              className="h-7 min-w-0 flex-1 overflow-hidden rounded-md bg-subtle"
            >
              <AccountSegment
                remaining={remainingPercent(window)}
                color={color}
                pending={Boolean(window.resetsAt)}
              />
              {numbered ? (
                <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                  <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                    {index + 1}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <View>
        {pool.columns.map(({ account, window }, index) => {
          if (!window) return null;
          const credits = account.limits.resetCredits?.availableCount ?? 0;
          const resetsIn = formatResetsIn(window, now);
          return (
            <Pressable
              key={account.key}
              accessibilityRole="button"
              accessibilityLabel={`Segment ${index + 1}, ${accountName(account)}, ${remainingPercent(window)}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset credits banked` : ""}`}
              accessibilityHint="Show account details"
              onPress={() => openAccount(account)}
              className="min-h-[44px] flex-row items-center gap-2 active:opacity-60"
            >
              {numbered ? (
                <View className="size-5 items-center justify-center overflow-hidden rounded-md bg-subtle-strong">
                  <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                    {index + 1}
                  </Text>
                </View>
              ) : null}
              <Text
                numberOfLines={1}
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
              >
                {accountName(account)}
              </Text>
              <Text className="text-sm font-t3-medium tabular-nums text-foreground">
                {remainingPercent(window)}%
              </Text>
              <View className="flex-row items-center gap-1">
                {resetsIn ? (
                  <Text className="text-xs tabular-nums text-foreground-muted">
                    {resetsIn.replace("resets in ", "↻ ")}
                  </Text>
                ) : null}
                {credits ? (
                  <>
                    {resetsIn ? <Text className="text-xs text-foreground-tertiary">·</Text> : null}
                    <SymbolView name="ticket" size={13} tintColorClassName="accent-icon" />
                    <Text className="text-xs font-t3-medium tabular-nums text-foreground">
                      {credits}
                    </Text>
                  </>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * 24h / 7d / 30d tokens for one provider over the selected environments.
 * Served from the usage cache; the screen's pull-to-refresh moves `openedAt`
 * and refreshes the same windows (see `useRefreshLimits`).
 */
function TokenRows({
  driver,
  openedAt,
  environmentIds,
}: {
  readonly driver: string;
  readonly openedAt: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const provider = usageProviderForDriver(driver);
  const [day, week, month] = useMemo(() => tokenUsageWindows(openedAt), [openedAt]);
  const selected = useMemo(
    () =>
      environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id))),
    [environmentIds],
  );
  const dayUsage = useUsage(day, selected);
  const weekUsage = useUsage(week, selected);
  const monthUsage = useUsage(month, selected);
  const d = dayUsage.merged.providers;
  const w = weekUsage.merged.providers;
  const m = monthUsage.merged.providers;
  if (!provider) return null;
  const rows = railTokenRows(provider, [
    { label: "24h", providers: d },
    { label: "7d", providers: w },
    { label: "30d", providers: m },
  ]);
  return rows.map((row) => (
    <View key={row.label} className="gap-0.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm font-t3-medium text-foreground">{row.label}</Text>
        <Text className="text-xs tabular-nums text-foreground-muted">{row.tokens}</Text>
      </View>
      <Text className="text-xs tabular-nums text-foreground-muted">{row.sessions}</Text>
    </View>
  ));
}

/** One rounded card per provider, as the desktop Usage page draws it. */
export function ProviderUsageCard({
  pool,
  now,
  environmentIds,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly environmentIds: readonly string[] | null;
}) {
  const colors = useProviderColors();
  const providerLabel = limitDriverLabel(pool.driver);
  const single = pool.accounts.length === 1 ? (pool.accounts[0] ?? null) : null;
  const accountLine = single
    ? single.displayName && single.displayName.toLowerCase() !== providerLabel.toLowerCase()
      ? single.displayName
      : "Default account"
    : `${pool.accounts.length} accounts`;
  const plan = single ? railPlanLabel(single.plan, providerLabel) : null;
  const windows = displayLimitWindows(pool);
  const navigation = useNavigation();
  // Multi-account cards open an account from its legend row; a lone account
  // opens from the header, since its windows render as plain rows.
  const firstWindow = windows[0];
  const openSingleAccount = () => {
    if (!single || !firstWindow) return;
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsUsageAccount",
        params: {
          accountKey: single.key,
          windowId: firstWindow.id,
          windowKind: firstWindow.kind,
          environmentIds,
          now,
        },
      },
    });
  };
  const rows = single
    ? buildRailUsageCardRows(
        windows.flatMap((window) => {
          const member = window.members[0]?.window;
          if (!member) return [];
          const details =
            pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
          return [{ ...member, label: details?.label ?? member.label }];
        }),
        now,
      )
    : [];
  const creditAccounts = pool.accounts.filter(
    (account) => account.redeem && account.limits.resetCredits,
  );
  const showDetails = creditAccounts.length > 0 || usageProviderForDriver(pool.driver) !== null;
  return (
    <View className="gap-5 rounded-2xl border border-border-subtle bg-card p-5">
      <Pressable
        disabled={!single || !firstWindow}
        accessibilityRole={single && firstWindow ? "button" : undefined}
        accessibilityHint={single && firstWindow ? "Show account details" : undefined}
        onPress={openSingleAccount}
        className="flex-row items-center gap-3 active:opacity-60"
      >
        <View className="size-9 items-center justify-center rounded-lg border border-border-subtle">
          <ProviderIcon provider={pool.driver} size={20} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-medium text-foreground">{providerLabel}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {accountLine}
          </Text>
        </View>
        {plan ? (
          <View className="rounded-full bg-subtle-strong px-2.5 py-1">
            <Text className="text-xs font-t3-medium text-foreground">{plan}</Text>
          </View>
        ) : null}
        {single && firstWindow ? (
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        ) : null}
      </Pressable>
      <View className="gap-5">
        {single
          ? rows.map((row) => <UsageWindowRow key={row.id} row={row} />)
          : windows.map((window) => {
              const details =
                pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
              return (
                <PoolWindow
                  key={`${window.kind}:${window.id}`}
                  pool={window}
                  color={driverColor(colors, pool.driver)}
                  now={now}
                  environmentIds={environmentIds}
                  label={details?.label}
                  description={details?.description}
                />
              );
            })}
      </View>
      {showDetails ? (
        <View className="gap-4 border-t border-border-subtle pt-5">
          <Text className="text-sm font-t3-medium text-foreground">Details</Text>
          {creditAccounts.map((account) => (
            <View key={account.key} className="gap-2">
              {creditAccounts.length > 1 ? (
                <Text className="text-xs text-foreground-muted">{accountName(account)}</Text>
              ) : null}
              {account.redeem && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </View>
          ))}
          <TokenRows driver={pool.driver} openedAt={now} environmentIds={environmentIds} />
        </View>
      ) : null}
    </View>
  );
}
