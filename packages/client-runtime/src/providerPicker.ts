import {
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderInstanceConfigMap,
  type DetectedProvider,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/** Built-in drivers onboarding lists, in display order. */
const ONBOARDING_AGENT_DRIVERS: readonly ProviderDriverKind[] = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "commandCode",
  "droid",
  "devin",
  "pi",
  "muse",
].map((driver) => ProviderDriverKind.make(driver));

/** Drivers the onboarding cards show: every enabled built-in provider, in display order. */
export function resolveOnboardingAgentDrivers(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): ProviderDriverKind[] {
  const enabled = new Set(
    (providers ?? [])
      .filter((provider) => provider.enabled && provider.status !== "disabled")
      .map((provider) => provider.driver),
  );
  return ONBOARDING_AGENT_DRIVERS.filter((driver) => enabled.has(driver));
}

export interface ProviderPickerRow {
  readonly driver: ProviderDriverKind;
  /** Null while the lookup runs. */
  readonly found: boolean | null;
  readonly blockedByAdmin?: boolean;
}

/** Every built-in provider in display order, marked by the filesystem lookup. */
export function buildProviderPickerRows(
  detected: ReadonlyArray<DetectedProvider> | null,
  blockedDrivers: ReadonlyArray<ProviderDriverKind> = [],
): ProviderPickerRow[] {
  const byDriver = new Map(detected?.map((provider) => [provider.driver, provider]));
  return ONBOARDING_AGENT_DRIVERS.map((driver) => {
    const provider = byDriver.get(driver);
    return {
      driver,
      ...(blockedDrivers.includes(driver) ? { blockedByAdmin: true } : {}),
      found: detected === null ? null : provider?.installed === true,
    };
  });
}

/** Only actionable rows count as choices, including when policy arrives after a click. */
export function selectedProviderPickerDrivers(
  rows: ReadonlyArray<ProviderPickerRow>,
  picked: ReadonlySet<ProviderDriverKind>,
): ReadonlySet<ProviderDriverKind> {
  return new Set(
    rows.filter((row) => !row.blockedByAdmin && picked.has(row.driver)).map((row) => row.driver),
  );
}

/** Turns on exactly the picked providers; the rest keep their current state. */
export function providerPickerPatch(
  picked: ReadonlySet<ProviderDriverKind>,
  currentInstances: ProviderInstanceConfigMap = {},
  blockedDrivers: ReadonlyArray<ProviderDriverKind> = [],
): ServerSettingsPatch {
  return {
    providerInstances: {
      ...currentInstances,
      ...Object.fromEntries(
        ONBOARDING_AGENT_DRIVERS.filter(
          (driver) => picked.has(driver) && !blockedDrivers.includes(driver),
        ).map((driver) => {
          const instanceId = defaultInstanceIdForDriver(driver);
          const current = currentInstances[instanceId] ?? { driver };
          return [
            instanceId,
            {
              ...current,
              enabled: true,
              ...(providerInstanceConfigEnabledFlag(current.config) === false
                ? { config: { ...(current.config as Record<string, unknown>), enabled: true } }
                : {}),
            },
          ];
        }),
      ),
    },
  };
}

type ProviderSnapshot = Pick<ServerProvider, "enabled" | "status" | "disabledByAdmin">;

const isLiveEnabled = (provider: ProviderSnapshot) =>
  provider.enabled && provider.status !== "disabled" && provider.disabledByAdmin !== true;

export function resolveProviderSetup(input: {
  readonly instances: ProviderInstanceConfigMap | null;
  readonly blockedDrivers: ReadonlyArray<ProviderDriverKind>;
  readonly providers: ReadonlyArray<ProviderSnapshot> | null;
}) {
  const enabled =
    input.instances === null
      ? input.providers?.some(isLiveEnabled)
      : Object.values(input.instances).some(
          (instance) =>
            resolveProviderInstanceEnabled(instance) &&
            !input.blockedDrivers.includes(instance.driver),
        );
  return {
    pending: enabled === undefined,
    showPicker: enabled === false,
    refreshEnabledProviders: enabled === true,
  };
}

/**
 * What a chat on one environment shows while that server has no AI tool turned
 * on. The browser's own onboarding flag plays no part: a browser that finished
 * the wizard can still meet a brand-new server.
 *
 * - `picker`: the "Which AI tools do you use?" dialog.
 * - `inline`: a notice that reopens it, once the user closed it on this environment.
 * - `inline-read-only`: a notice only; this connection cannot change providers.
 *
 * Settings and the server's snapshot must both say nothing is on. An older
 * settings file without provider entries still runs the built-in defaults,
 * which only the snapshot shows.
 */
export type ProviderPickerPrompt = "hidden" | "picker" | "inline" | "inline-read-only";

export function resolveProviderPickerPrompt(input: {
  readonly environmentId: EnvironmentId;
  readonly instances: ProviderInstanceConfigMap | null;
  readonly blockedDrivers: ReadonlyArray<ProviderDriverKind>;
  readonly providers: ReadonlyArray<ProviderSnapshot> | null;
  readonly canManage: boolean;
  readonly dismissedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ProviderPickerPrompt {
  if (input.providers === null || input.providers.some(isLiveEnabled)) return "hidden";
  if (!resolveProviderSetup(input).showPicker) return "hidden";
  if (!input.canManage) return "inline-read-only";
  return input.dismissedEnvironmentIds.has(input.environmentId) ? "inline" : "picker";
}
