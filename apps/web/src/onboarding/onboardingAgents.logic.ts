import {
  ProviderDriverKind,
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
}

/** Every built-in provider in display order, marked by the filesystem lookup. */
export function buildProviderPickerRows(
  detected: ReadonlyArray<DetectedProvider> | null,
): ProviderPickerRow[] {
  const byDriver = new Map(detected?.map((provider) => [provider.driver, provider]));
  return ONBOARDING_AGENT_DRIVERS.map((driver) => {
    const provider = byDriver.get(driver);
    return {
      driver,
      found: detected === null ? null : provider?.installed === true,
    };
  });
}

/** Turns on exactly the picked providers; the rest keep their current state. */
export function providerPickerPatch(picked: ReadonlySet<ProviderDriverKind>): ServerSettingsPatch {
  return {
    providers: Object.fromEntries(
      ONBOARDING_AGENT_DRIVERS.filter((driver) => picked.has(driver)).map((driver) => [
        driver,
        { enabled: true },
      ]),
    ),
  } as ServerSettingsPatch;
}
