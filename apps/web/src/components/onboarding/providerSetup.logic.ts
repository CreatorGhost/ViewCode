import {
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";

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
