import { useAtomValue } from "@effect/atom-react";
import {
  buildProviderPickerRows,
  providerPickerPatch,
  resolveProviderPickerPrompt,
  selectedProviderPickerDrivers,
} from "@t3tools/client-runtime/provider-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type DetectedProvider,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

const NO_DISMISSED: ReadonlySet<EnvironmentId> = new Set();

function providerName(driver: ProviderDriverKind): string {
  return driver === "claudeAgent" ? "Claude Code" : (PROVIDER_DISPLAY_NAMES[driver] ?? driver);
}

/**
 * Web's "No AI tool is turned on" for the phone: every built-in provider starts off, so a chat on
 * a fresh server has nothing to answer it. The notice sits above the composer until a provider is
 * on; "Turn one on" opens the same picker web shows, inside the notice.
 */
export function NoProviderNotice(props: { readonly environmentId: EnvironmentId }) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const machineLabel = useAtomValue(
    environmentCatalog.catalogValueAtom,
    (catalog) => catalog.entries.get(props.environmentId)?.target.label ?? null,
  );
  const [picking, setPicking] = useState(false);
  // Saving returns before the server's provider snapshot does; say so instead of looking stuck.
  const [starting, setStarting] = useState(false);
  const prompt = resolveProviderPickerPrompt({
    environmentId: props.environmentId,
    instances: config?.settings.providerInstances ?? null,
    blockedDrivers: config?.adminBlockedProviderDrivers ?? [],
    providers: config?.providers ?? null,
    canManage,
    dismissedEnvironmentIds: NO_DISMISSED,
  });
  if (prompt === "hidden") return null;
  const machine = machineLabel ?? "this computer";
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-warning-border bg-warning p-3"
    >
      <Text className="text-sm font-t3-medium text-foreground">No AI tool is turned on</Text>
      <Text className="text-xs text-foreground-muted">
        {starting
          ? "Starting the tools you picked…"
          : prompt === "inline-read-only"
            ? `This connection cannot change providers. Ask whoever runs ${machine} to turn one on in Settings → Providers.`
            : `Nothing can answer here until you turn one on for ${machine}.`}
      </Text>
      {prompt === "inline-read-only" || starting ? null : picking ? (
        <ProviderPicker
          environmentId={props.environmentId}
          onCancel={() => setPicking(false)}
          onTurnedOn={() => {
            setStarting(true);
            setPicking(false);
          }}
        />
      ) : (
        <View className="self-start">
          <RequestActionButton label="Turn one on" onPress={() => setPicking(true)} />
        </View>
      )}
    </View>
  );
}

function ProviderPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly onCancel: () => void;
  readonly onTurnedOn: () => void;
}) {
  const { environmentId } = props;
  const detectProviders = useAtomCommand(serverEnvironment.detectProviders, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const config = useEnvironmentServerConfig(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [detected, setDetected] = useState<ReadonlyArray<DetectedProvider> | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<ProviderDriverKind>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void detectProviders({ environmentId, input: {} }).then((result) => {
      if (!current) return;
      // A failed lookup still lists every provider, just without marks.
      setDetected(result._tag === "Success" ? result.value.providers : []);
    });
    return () => {
      current = false;
    };
  }, [detectProviders, environmentId]);

  const blockedDrivers = config?.adminBlockedProviderDrivers ?? [];
  const rows = buildProviderPickerRows(detected, blockedDrivers);
  const selected = selectedProviderPickerDrivers(rows, picked);

  const turnOn = async () => {
    if (config === null || selected.size === 0 || !canManage) return;
    setSaving(true);
    setError(null);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: providerPickerPatch(selected, config.settings.providerInstances, blockedDrivers),
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onTurnedOn();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setError(
      cause instanceof Error && cause.message ? cause.message : "Couldn't save your choice.",
    );
  };

  const disabled = saving || !canManage || config === null;
  return (
    <View className="gap-2">
      <Text className="text-xs text-foreground-muted">
        ViewCode will start the tools you pick. If your company blocks one, leave it off.
      </Text>
      <ScrollView className="max-h-72" nestedScrollEnabled>
        {rows.map((row) => {
          const name = providerName(row.driver);
          const checked = row.blockedByAdmin !== true && picked.has(row.driver);
          const rowDisabled = disabled || row.blockedByAdmin === true;
          return (
            <Pressable
              key={row.driver}
              accessibilityRole="checkbox"
              accessibilityLabel={`Let ViewCode start ${name}`}
              accessibilityState={{ checked, disabled: rowDisabled }}
              disabled={rowDisabled}
              onPress={() =>
                setPicked((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(row.driver);
                  else next.add(row.driver);
                  return next;
                })
              }
              className="min-h-11 flex-row items-center gap-2.5 active:opacity-70 disabled:opacity-50"
            >
              <SymbolView
                name={checked ? "checkmark.circle.fill" : "circle"}
                size={18}
                tintColorClassName={checked ? "accent-primary" : "accent-icon-muted"}
              />
              <ProviderIcon provider={row.driver} size={16} />
              <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                {name}
              </Text>
              <Text
                className={
                  row.found === true
                    ? "shrink-0 text-xs text-adaptive-emerald-600-400"
                    : "shrink-0 text-xs text-foreground-muted"
                }
              >
                {row.blockedByAdmin
                  ? "Blocked by your organization"
                  : row.found === null
                    ? "Checking…"
                    : row.found
                      ? "Found"
                      : "Not found"}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <RequestActionButton label="Cancel" tone="secondary" onPress={props.onCancel} />
        <RequestActionButton
          label={
            saving
              ? "Turning on…"
              : selected.size === 1
                ? "Turn on 1 tool"
                : `Turn on ${selected.size} tools`
          }
          disabled={selected.size === 0 || disabled}
          onPress={() => void turnOn()}
        />
      </View>
    </View>
  );
}
