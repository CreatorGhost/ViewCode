import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import { formatDuration, limitsNotice, usageRefreshNotice } from "@t3tools/shared/usageLimits";
import { buildRailUsageCardRows } from "@t3tools/shared/usagePace";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { refreshUsage, refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { Alert, Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { UsageWindowRow } from "./UsageWindowRow";
import { tokenUsageWindows } from "./usageScreenModel";

type Driver = ServerProvider["driver"];

function AccountInstanceLabel({ value }: { readonly value: string }) {
  const [revealed, setRevealed] = useState(false);
  if (!value.includes("@")) {
    return (
      <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
        · {value}
      </Text>
    );
  }
  return (
    <Pressable
      className="shrink active:opacity-60"
      accessibilityRole="button"
      accessibilityLabel={revealed ? "Hide account label" : "Reveal account label"}
      onPress={() => setRevealed((current) => !current)}
    >
      <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
        · {revealed ? value : "••••••@••••••"}
      </Text>
    </Pressable>
  );
}

/** One account: icon, name and plan on a single line, then its windows. */
export function AccountLimits(props: {
  readonly driver: Driver;
  readonly label: string;
  readonly instanceLabel: string;
  readonly detail: string | undefined;
  readonly limits: ServerProvider["usageLimits"];
  readonly now: number;
  readonly first: boolean;
  /** Tighter padding for the composer card. */
  readonly dense?: boolean;
  /** Sits at the end of the heading row, such as a close control. */
  readonly trailing?: ReactNode;
  readonly footer?: ReactNode;
}) {
  const { limits, now, dense = false } = props;
  if (!limits) return null;
  const notice = limitsNotice(limits);
  const externalUsage = limits.externalUsage;
  const padding = dense ? "px-4 py-3" : "p-4";
  return (
    <View
      className={
        props.first ? `gap-3 ${padding}` : `gap-3 border-t border-border-subtle ${padding}`
      }
    >
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={props.driver} size={16} />
        <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
          {props.instanceLabel !== props.label ? (
            <AccountInstanceLabel key={props.instanceLabel} value={props.instanceLabel} />
          ) : null}
          {props.detail ? (
            <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
              · {props.detail}
            </Text>
          ) : null}
        </View>
        {props.trailing}
      </View>
      {notice ? (
        <Text className="text-sm text-foreground-muted">{notice}</Text>
      ) : (
        <View className="gap-3">
          {buildRailUsageCardRows(limits.windows, now).map((row) => (
            <UsageWindowRow key={row.id} row={row} />
          ))}
        </View>
      )}
      {externalUsage ? (
        <Pressable
          accessibilityRole="link"
          className="min-h-11 justify-center"
          onPress={() => void Linking.openURL(externalUsage.url).catch(() => undefined)}
        >
          <Text className="text-sm font-t3-medium text-primary">Manage usage</Text>
        </Pressable>
      ) : null}
      {props.footer}
      {usageRefreshNotice(limits) ? (
        <Text className="text-sm text-foreground-muted">{usageRefreshNotice(limits)}</Text>
      ) : null}
    </View>
  );
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Banked reset credits with a confirmed redeem action. Redeeming spends a
 * credit the provider granted the user, so it goes through the native
 * confirm alert rather than firing on a bare tap.
 */
export function ResetCredits(props: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
  /** A smaller pill for the composer card. */
  readonly dense?: boolean;
}) {
  const { environmentId, input, credits, now, dense = false } = props;
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (dense && credits.availableCount === 0 && status === null) return null;

  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  const summary =
    credits.availableCount === 0
      ? "No reset credits banked"
      : `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
          expiresIn ? ` · next expires in ${expiresIn}` : ""
        }`;

  const redeem = async () => {
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    setStatus(
      "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not use the reset credit.",
    );
  };

  const confirm = () => {
    Alert.alert(
      "Use a reset credit?",
      "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Use credit", onPress: () => void redeem() },
      ],
    );
  };

  if (!dense) {
    return (
      <View className="gap-3">
        <View className="gap-1">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-sm font-t3-medium text-foreground">Banked resets</Text>
            <Text className="text-xs tabular-nums text-foreground-muted">
              {credits.availableCount > 0 ? `${credits.availableCount} available` : "None"}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted">
            Use when your 5-hour or weekly limit has 10% or less remaining.
          </Text>
        </View>
        {credits.availableCount > 0 ? (
          <View className="flex-row items-center justify-between gap-3">
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm text-foreground">Reset 1</Text>
              {expiresIn ? (
                <Text className="text-xs tabular-nums text-foreground-muted">
                  Expires in {expiresIn}
                </Text>
              ) : null}
            </View>
            {credits.canRedeem !== false ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={confirm}
                className="min-h-[44px] justify-center rounded-md bg-subtle-strong px-3 py-1.5"
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  {busy ? "Using…" : "Use reset"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
      </View>
    );
  }

  return (
    <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
      <Text className="text-xs tabular-nums text-foreground-tertiary">{summary}</Text>
      {credits.availableCount > 0 && credits.canRedeem !== false ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={confirm}
          className={
            dense
              ? "rounded-md bg-subtle-strong px-2.5 py-1"
              : "min-h-[44px] justify-center rounded-md bg-subtle-strong px-3 py-1.5"
          }
        >
          <Text
            className={
              dense
                ? "text-xs font-t3-medium text-foreground"
                : "text-sm font-t3-medium text-foreground"
            }
          >
            {busy ? "Using…" : "Use reset"}
          </Text>
        </Pressable>
      ) : null}
      {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
    </View>
  );
}

/**
 * Re-probes every provider (and usage-limit source) on each connected
 * environment; the fresh snapshots then arrive over the config stream.
 * Countdowns and pace anchor to `now` rather than ticking, so a refresh also
 * re-anchors the clock: quota and elapsed time move together, or not at all.
 * Environments whose probe failed are named, since their rows keep showing
 * the previous quota with nothing else to say so.
 */
export function useRefreshLimits(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  active = false,
) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [failedEnvironments, setFailedEnvironments] = useState<
    readonly { environmentId: EnvironmentId; label: string }[]
  >([]);
  const refresh = async (automatic = false, afterPending = false, at = Date.now()) => {
    const connected = [...presentations].filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    );
    try {
      await Promise.all(
        connected.map(async ([environmentId, presentation]) => {
          const result = await refreshUsageLimits(
            environmentId,
            () => refreshProviders({ environmentId, input: {} }),
            automatic,
            afterPending,
          );
          if (result === undefined) return;
          setFailedEnvironments((previous) => [
            ...previous.filter((failed) => failed.environmentId !== environmentId),
            ...(result._tag === "Failure"
              ? [{ environmentId, label: presentation.entry.target.label }]
              : []),
          ]);
        }),
      );
    } finally {
      setNow(at);
    }
  };
  // The provider cards total tokens from the usage cache; a manual refresh re-reads those windows.
  const refreshTokens = async (at: number) => {
    const environmentIds = [...presentations]
      .filter(
        ([environmentId, presentation]) =>
          presentation.connection.phase === "connected" &&
          (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
      )
      .map(([environmentId]) => environmentId);
    await Promise.all(
      tokenUsageWindows(at).map((input) =>
        refreshUsage({
          registry: appAtomRegistry,
          server: serverEnvironment,
          presentations: environmentPresentations,
          environmentIds,
          input,
        }).catch(() => undefined),
      ),
    );
  };
  // Always toggles `refreshing`, even with nothing to probe: Android's
  // RefreshControl keeps its spinner up until it sees true then false.
  const refreshManually = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const at = Date.now();
      await Promise.all([refresh(false, false, at), refreshTokens(at)]);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => refresh(true));
  useEffect(() => {
    if (active && connectedLimitsEnvironments) void autoRefreshLimits();
  }, [active, connectedLimitsEnvironments]);

  const failedLabels = failedEnvironments
    .filter(
      ({ environmentId }) =>
        selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId),
    )
    .map(({ label }) => label);
  return {
    now,
    refreshing,
    failedLabels,
    refresh: refreshManually,
    refreshAfterEnable: () => refresh(false, true),
  };
}
