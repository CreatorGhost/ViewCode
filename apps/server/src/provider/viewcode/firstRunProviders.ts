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
