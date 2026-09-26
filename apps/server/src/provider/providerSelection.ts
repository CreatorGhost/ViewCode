/**
 * ViewCode: the first-run provider choice.
 *
 * A fresh environment starts no provider CLI until the user picks which ones
 * it may run (`ServerSettings.providerSelection`). On EDR-managed machines
 * merely launching a blocked CLI gets the server killed, so nothing may be
 * probed before that choice. Upstream's schema defaults (Codex on) are
 * untouched; this gate sits in front of them.
 *
 * - `"pending"`: every provider instance is disabled in the effective
 *   instance map, so no boot probe, refresh, session or text generation can
 *   launch one. Persisted, so it survives restarts until the user chooses,
 *   even if projects are created meanwhile.
 * - `"chosen"` or absent (settings that predate the gate): settings apply as
 *   in upstream T3 Code.
 *
 * Pure functions only; `serverSettings.ts` imports this module.
 *
 * @module provider/providerSelection
 */
import {
  DEFAULT_SERVER_SETTINGS,
  providerInstanceConfigEnabledFlag,
  type ProviderDriverKind,
  ProviderDriverKind as ProviderDriverKindSchema,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Built-in drivers, in the order the legacy `providers` settings list them. */
export const BUILT_IN_PROVIDER_DRIVER_KINDS: ReadonlyArray<ProviderDriverKind> = Object.keys(
  DEFAULT_SERVER_SETTINGS.providers,
).map((kind) => ProviderDriverKindSchema.make(kind));

export function isProviderSelectionPending(settings: ServerSettings): boolean {
  return settings.providerSelection === "pending";
}

/**
 * The effective instance map while the choice is pending: every instance
 * disabled. Applied in `deriveProviderInstanceConfigMap`, so closing the
 * selection changes the map and the registry rebuilds exactly the instances
 * that became enabled.
 */
export function gateProviderInstanceConfigMap(
  settings: ServerSettings,
  configMap: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  if (!isProviderSelectionPending(settings)) return configMap;
  const gated: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, entry] of Object.entries(configMap)) {
    gated[instanceId] = { ...entry, enabled: false };
  }
  return gated as ProviderInstanceConfigMap;
}

const decodeLenientJson = Schema.decodeUnknownOption(fromLenientJson(Schema.Unknown));

/**
 * Whether raw `settings.json` records provider decisions: an explicit
 * `providers.<driver>.enabled`, or any provider instance.
 */
export function hasPersistedProviderChoices(rawSettingsJson: string): boolean {
  const decoded = decodeLenientJson(rawSettingsJson);
  if (decoded._tag === "None" || !Predicate.isObject(decoded.value)) return false;
  const { providers, providerInstances } = decoded.value as {
    readonly providers?: unknown;
    readonly providerInstances?: unknown;
  };
  if (
    Predicate.isObject(providers) &&
    Object.values(providers).some(
      (entry) => Predicate.isObject(entry) && typeof entry["enabled"] === "boolean",
    )
  ) {
    return true;
  }
  return Predicate.isObject(providerInstances) && Object.keys(providerInstances).length > 0;
}

/**
 * Decide the selection once, at the first settings load of a build that has
 * the gate (the field is absent until then), from what was persisted before
 * defaults were applied:
 *
 * - an unreadable settings file: pending, since defaults are not permission;
 * - a used environment (any project or thread) or persisted provider
 *   decisions: chosen, so existing installs behave exactly as before;
 * - anything else (fresh or never-used install): pending.
 */
export function decideProviderSelection(
  settings: ServerSettings,
  input: {
    readonly rawSettingsJson: string | undefined;
    readonly settingsFileTrusted: boolean;
    readonly hasHistory: boolean;
  },
): ServerSettings {
  if (settings.providerSelection !== undefined) return settings;
  const chosen =
    input.settingsFileTrusted &&
    (input.hasHistory ||
      (input.rawSettingsJson !== undefined && hasPersistedProviderChoices(input.rawSettingsJson)));
  return { ...settings, providerSelection: chosen ? "chosen" : "pending" };
}

/** The patch `server.chooseProviders` applies: exactly these drivers on. */
export function makeChooseProvidersPatch(
  enabled: ReadonlyArray<ProviderDriverKind>,
): ServerSettingsPatch {
  const chosen = new Set<string>(enabled);
  return {
    providers: Object.fromEntries(
      BUILT_IN_PROVIDER_DRIVER_KINDS.map((kind) => [kind, { enabled: chosen.has(kind) }]),
    ) as NonNullable<ServerSettingsPatch["providers"]>,
    providerSelection: "chosen",
  };
}

/** Same precedence as the registry: an explicit false on either flag wins. */
const instanceEnabled = (entry: ProviderInstanceConfig): boolean | undefined => {
  const configEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || configEnabled === false) return false;
  return entry.enabled ?? configEnabled;
};

function withInstanceEnabled(entry: ProviderInstanceConfig, enabled: boolean) {
  const config = entry.config;
  // The config blob's own flag would win over the envelope when false, so
  // drop it; the envelope carries the decision.
  if (Predicate.isObject(config) && "enabled" in config) {
    const { enabled: _dropped, ...rest } = config as Record<string, unknown>;
    return { ...entry, enabled, config: rest } satisfies ProviderInstanceConfig;
  }
  return { ...entry, enabled } satisfies ProviderInstanceConfig;
}

/**
 * Close the selection with every effective instance switched explicitly:
 * the legacy `providers.<driver>` slots and every `providerInstances` entry.
 */
function closeProviderSelection(
  settings: ServerSettings,
  isOn: (instanceId: string, driver: string) => boolean,
): ServerSettings {
  const providers = { ...settings.providers } as Record<string, { readonly enabled: boolean }>;
  for (const kind of BUILT_IN_PROVIDER_DRIVER_KINDS) {
    const current = providers[kind];
    if (current) providers[kind] = { ...current, enabled: isOn(kind, kind) };
  }
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, entry] of Object.entries(settings.providerInstances)) {
    providerInstances[instanceId] = withInstanceEnabled(entry, isOn(instanceId, entry.driver));
  }
  return {
    ...settings,
    providers: providers as unknown as ServerSettings["providers"],
    providerInstances: providerInstances as ServerSettings["providerInstances"],
    providerSelection: "chosen",
  };
}

/**
 * Selection rules for a settings update, given the settings before it, the
 * patch, and the result of applying the patch normally:
 *
 * - a choice (`providerSelection: "chosen"`) on a closed selection is stale
 *   (another client already chose): nothing changes;
 * - a choice on a pending selection enables all instances of the chosen
 *   drivers and disables every other instance;
 * - while pending, a patch that switches an instance on is the first choice:
 *   that instance on, every other instance off.
 */
export function applyProviderSelectionRules(
  current: ServerSettings,
  patch: ServerSettingsPatch,
  updated: ServerSettings,
): ServerSettings {
  const pending = isProviderSelectionPending(current);
  if (patch.providerSelection === "chosen") {
    if (!pending) return current;
    const chosenDrivers = new Set(
      Object.entries(patch.providers ?? {}).flatMap(([kind, value]) =>
        value?.enabled === true ? [kind] : [],
      ),
    );
    return closeProviderSelection(updated, (_instanceId, driver) => chosenDrivers.has(driver));
  }
  if (!pending) return updated;

  const turnedOn = new Set<string>();
  for (const [kind, value] of Object.entries(patch.providers ?? {})) {
    if (value?.enabled === true) turnedOn.add(kind);
  }
  for (const [instanceId, entry] of Object.entries(patch.providerInstances ?? {})) {
    const previous =
      current.providerInstances[instanceId as keyof typeof current.providerInstances];
    if (instanceEnabled(entry) === true && (!previous || instanceEnabled(previous) !== true)) {
      turnedOn.add(instanceId);
    }
  }
  if (turnedOn.size === 0) return updated;
  return closeProviderSelection(updated, (instanceId) => turnedOn.has(instanceId));
}
