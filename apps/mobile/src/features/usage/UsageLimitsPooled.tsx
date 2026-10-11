import { useAtomValue } from "@effect/atom-react";
import { useLinkTo, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  remainingPercent,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useAgentControlByThreadKey } from "../../state/agentControl";
import { useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderUsageCard } from "./ProviderUsageCard";
import { ResetCredits } from "./UsageLimitsSection";
import {
  limitDriverLabel,
  limitWarnings,
  providersAwaitingData,
  usageResumeRows,
} from "./usageScreenModel";

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  cursorPrompt,
  onRetry,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  /** Re-probes providers through the screen's existing refresh. */
  readonly onRetry?: () => void;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly cursorPrompt?: ReactNode;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const pools = collectLimitPools(collectLimitAccounts(selected), now);
  const notices = limitWarnings(collectLimitNotices(selected));
  const awaitingData = providersAwaitingData(selected);
  const externalLinks = collectExternalUsageLinks(selected);
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <View className="gap-6">
      <UsageResumeSection selectedEnvironmentIds={selectedEnvironmentIds} now={now} />
      {pools.length === 0 &&
      notices.length === 0 &&
      awaitingData.length === 0 &&
      failedLabels.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? "Select an environment to see limits."
            : "No provider on the selected environments reports subscription limits."}
        </Text>
      ) : null}
      {pools.map((pool, index) => (
        <Fragment key={pool.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <ProviderUsageCard
            pool={pool}
            now={now}
            environmentIds={selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds]}
          />
        </Fragment>
      ))}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      {awaitingData.length > 0 ? (
        <View className="rounded-lg border border-border-subtle bg-card">
          {awaitingData.map((provider, index) => (
            <View
              key={provider.key}
              className={
                index === 0
                  ? "flex-row items-center gap-2 p-4"
                  : "flex-row items-center gap-2 border-t border-border-subtle p-4"
              }
            >
              <ProviderIcon provider={provider.driver} size={16} />
              <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                {provider.label}
              </Text>
              <Text className="text-sm text-foreground-muted">No data yet</Text>
            </View>
          ))}
        </View>
      ) : null}
      {externalLinks.map((link) => (
        <View key={link.url} className="gap-3 rounded-xl border border-border-subtle p-4">
          <Text className="text-base font-t3-medium text-foreground">{link.label}</Text>
          <Text className="text-xs text-foreground-muted">{link.accounts.join(", ")}</Text>
          {link.message ? (
            <Text className="text-sm text-foreground-muted">{link.message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
          >
            <Text className="text-sm font-t3-medium text-primary">Manage usage</Text>
          </Pressable>
        </View>
      ))}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-t3-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-t3-medium text-warning-foreground">
                {failedLabels.join(", ")} could not refresh limits. Showing the last known values.
              </Text>
            ) : null}
          </View>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading limits"
              className="active:opacity-60"
              onPress={onRetry}
            >
              <Text className="text-sm font-t3-medium text-warning-foreground">Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Threads a usage limit stopped, with when each continues by itself. Read from
 * the agent-control stream the thread view already follows; tapping a row
 * opens the thread, where Cancel and Resume now live.
 */
function UsageResumeSection({
  selectedEnvironmentIds,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const threads = useThreadShells();
  const linkTo = useLinkTo();
  const connected = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId);
  const control = useAgentControlByThreadKey(connected);
  const titles = new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread.title]),
  );
  const rows = usageResumeRows({
    control,
    titleOf: (environmentId, threadId) => titles.get(`${environmentId}:${threadId}`) ?? null,
    nowMs: now,
  });
  if (rows.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="px-1 text-base font-t3-medium text-foreground">Waiting on a limit</Text>
      <View className="rounded-lg border border-border-subtle bg-card">
        {rows.map((row, index) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityHint="Opens the thread"
            onPress={() =>
              linkTo(
                `/threads/${encodeURIComponent(row.environmentId)}/${encodeURIComponent(row.threadId)}`,
              )
            }
            className={
              index === 0
                ? "min-h-[44px] gap-0.5 p-4 active:opacity-60"
                : "min-h-[44px] gap-0.5 border-t border-border-subtle p-4 active:opacity-60"
            }
          >
            <Text className="text-base text-foreground" numberOfLines={1}>
              {row.title}
            </Text>
            <Text className="text-sm tabular-nums text-foreground-muted">{row.text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
  now: number;
}>;

/** Resolve the account again so live quota and credit updates reach the open detail screen. */
export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const { accountKey, windowId, windowKind, environmentIds, now } = route.params;
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.driver === account?.driver)
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const window = pool?.members.find((member) => member.account.key === accountKey)?.window;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <SettingsScreen title="Account">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            This account is no longer reporting limits on the selected environments.
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ?? limitDriverLabel(account.driver)}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-lg border border-border-subtle bg-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {remainingPercent(window)}% left
              </Text>
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  Resets{" "}
                  {new Date(window.resetsAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              ) : null}
              {reset && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Restores {reset.restoresPercent}% of the pool
                </Text>
              ) : null}
            </View>
            <View className="gap-2 rounded-lg border border-border-subtle bg-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length ? "Signed in" : "Source"}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-lg border border-border-subtle bg-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">Reset credits</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : !account.limits.resetCredits && account.limits.resetCreditsUnavailableReason ? (
              <View className="gap-3 rounded-lg border border-border-subtle bg-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">Reset credits</Text>
                <Text className="text-sm text-foreground-muted">
                  {account.limits.resetCreditsUnavailableReason}
                </Text>
                {account.driver === "claudeAgent"
                  ? account.environments.map((environment) => (
                      <ClaudeKeychainEnableAction
                        key={environment.environmentId}
                        environmentId={environment.environmentId}
                        label={environment.label}
                      />
                    ))
                  : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

/**
 * Turns on reading Claude's macOS Keychain login for banked resets. The phone
 * has no provider settings, so this is its only way in; Settings → Providers
 * on web and desktop turns it back off.
 */
function ClaudeKeychainEnableAction({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Claude account usage",
  });
  const [pending, setPending] = useState(false);
  if (settings?.claudeKeychainUsageEnabled !== false) return null;
  const enable = async () => {
    setPending(true);
    try {
      await updateSettings({
        environmentId,
        input: { patch: { claudeKeychainUsageEnabled: true } },
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Turn on Claude account usage on ${label}`}
      accessibilityHint="Requires access to your Claude login in macOS Keychain."
      disabled={pending}
      onPress={() => void enable()}
      className="self-start rounded-full bg-primary px-4 py-2"
    >
      <Text className="text-sm font-medium text-primary-foreground">Turn on</Text>
    </Pressable>
  );
}
