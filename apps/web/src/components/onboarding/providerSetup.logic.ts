import {
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";

export function resolveProviderSetup(input: {
  readonly instances: ProviderInstanceConfigMap | null;
  readonly blockedDrivers: ReadonlyArray<ProviderDriverKind>;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "enabled" | "status" | "disabledByAdmin">
  > | null;
}) {
  const enabled =
    input.instances === null
      ? input.providers?.some(
          (provider) =>
            provider.enabled && provider.status !== "disabled" && provider.disabledByAdmin !== true,
        )
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
