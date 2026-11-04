import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";

// A persisted off envelope also prevents a later CLI installation from enabling a provider.
const DEFAULT_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
  "muse",
  "commandCode",
  "droid",
  "devin",
];

export function disableFirstRunProviders(settings: ServerSettings): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  for (const driver of DEFAULT_DRIVERS) {
    const instanceId = ProviderInstanceId.make(driver);
    providerInstances[instanceId] = {
      ...(providerInstances[instanceId] ?? { driver: ProviderDriverKind.make(driver) }),
      enabled: false,
    };
  }
  for (const instanceId of Object.keys(providerInstances)) {
    const id = ProviderInstanceId.make(instanceId);
    providerInstances[id] = { ...providerInstances[id]!, enabled: false };
  }
  return { ...settings, providerInstances };
}

/**
 * Records every built-in provider the user never turned on or off as off, so an existing install
 * starts nothing it was not asked to (a company may ban a provider's binary). Returns `settings`
 * itself when every built-in already carries a choice.
 */
export function keepUnchosenProvidersOff(settings: ServerSettings): ServerSettings {
  const unchosen = DEFAULT_DRIVERS.filter(
    (driver) => settings.providerInstances[ProviderInstanceId.make(driver)]?.enabled === undefined,
  );
  if (unchosen.length === 0) return settings;
  const providerInstances = { ...settings.providerInstances };
  for (const driver of unchosen) {
    const instanceId = ProviderInstanceId.make(driver);
    providerInstances[instanceId] = {
      ...(providerInstances[instanceId] ?? { driver: ProviderDriverKind.make(driver) }),
      enabled: false,
    };
  }
  return { ...settings, providerInstances };
}
