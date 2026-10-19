/**
 * ViewCode: settings as IT's machine-wide policy allows them. The policy itself
 * (where it lives, its format) is `@t3tools/shared/viewcodeAdminPolicy`.
 *
 * @module provider/AdminProviderPolicy
 */
import {
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { isAdminBlockedProvider } from "./viewcode/providerPolicyDrivers.ts";

/**
 * Settings as the policy allows them: every blocked provider off, its legacy
 * slot and its instances alike. The file on disk keeps the user's own choice,
 * so lifting the policy restores it.
 */
export function applyAdminProviderPolicy(
  settings: ServerSettings,
  blockedDrivers: ReadonlyArray<string>,
): ServerSettings {
  if (blockedDrivers.length === 0) return settings;
  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
    ...settings.providerInstances,
  };
  for (const driver of blockedDrivers) {
    if (!isProviderDriverKind(driver)) continue;
    const instanceId = defaultInstanceIdForDriver(driver);
    providerInstances[instanceId] ??= { driver, enabled: false };
  }
  const blockedInstances = new Set<string>();
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    if (!isAdminBlockedProvider(instance, blockedDrivers)) continue;
    blockedInstances.add(instanceId);
    providerInstances[instanceId as ProviderInstanceId] = { ...instance, enabled: false };
  }
  return {
    ...settings,
    providerInstances,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([projectId, overrides]) => [
        projectId,
        {
          ...overrides,
          ...(overrides.providerInstances
            ? {
                providerInstances: Object.fromEntries(
                  Object.entries(overrides.providerInstances).map(([instanceId, override]) => [
                    instanceId,
                    blockedInstances.has(instanceId) ? { ...override, enabled: false } : override,
                  ]),
                ),
              }
            : {}),
        },
      ]),
    ),
  };
}
