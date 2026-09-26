import type {
  ModelCapabilities,
  ProviderDriverKind,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/**
 * Descriptor ids that carry a model's reasoning effort, in the order we prefer
 * them. Claude calls it `effort`, Codex and Grok `reasoningEffort`, Cursor
 * `reasoning` and OpenCode `variant`.
 */
const EFFORT_DESCRIPTOR_IDS = ["effort", "reasoningEffort", "reasoning", "variant"] as const;

/** Codex exposes fast mode as this service tier instead of a boolean. */
const CODEX_STANDARD_SERVICE_TIER_ID = "default";

export function findEffortDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): SelectDescriptor | null {
  for (const id of EFFORT_DESCRIPTOR_IDS) {
    const descriptor = descriptors.find(
      (candidate): candidate is SelectDescriptor =>
        candidate.type === "select" && candidate.id === id && candidate.options.length > 0,
    );
    if (descriptor) return descriptor;
  }
  return null;
}

export type EffortStop = { id: string; label: string };

export function buildEffortStops(descriptor: SelectDescriptor | null): ReadonlyArray<EffortStop> {
  return descriptor?.options.map(({ id, label }) => ({ id, label })) ?? [];
}

/** Index of `value` among the stops, falling back to the default option, then the first stop. */
export function resolveEffortStopIndex(
  descriptor: SelectDescriptor | null,
  value: string | null,
): number {
  if (!descriptor || descriptor.options.length === 0) return -1;
  const index = value === null ? -1 : descriptor.options.findIndex(({ id }) => id === value);
  if (index >= 0) return index;
  const defaultIndex = descriptor.options.findIndex(({ isDefault }) => isDefault === true);
  return Math.max(defaultIndex, 0);
}

/**
 * The highest effort a model offers (Max, Ultrathink) gets the warm "peak"
 * treatment; every other stop is standard. A single stop is never a peak.
 */
export type EffortTier = "standard" | "peak";

export function effortTierForIndex(index: number, stopCount: number): EffortTier {
  return stopCount > 1 && index === stopCount - 1 ? "peak" : "standard";
}

export type FastModeControl = {
  descriptorId: string;
  enabled: boolean;
  onValue: string | boolean;
  offValue: string | boolean;
};

/**
 * Claude and Cursor expose fast mode as a `fastMode` boolean; Codex exposes it
 * as a Standard/Fast service tier. A service tier set to anything else (Flex)
 * is not a plain on/off switch, so it stays an ordinary option.
 */
export function resolveFastModeControl(
  provider: ProviderDriverKind,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): FastModeControl | null {
  const boolean = descriptors.find(
    (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
  );
  if (boolean) {
    return {
      descriptorId: boolean.id,
      enabled: boolean.currentValue === true,
      onValue: true,
      offValue: false,
    };
  }
  if (provider !== "codex") return null;
  const serviceTier = descriptors.find(
    (descriptor): descriptor is SelectDescriptor =>
      descriptor.id === "serviceTier" && descriptor.type === "select",
  );
  const fastTier = serviceTier?.options.find(({ label }) => label === "Fast");
  if (!serviceTier || !fastTier) return null;
  const currentValue = getProviderOptionCurrentValue(serviceTier);
  if (currentValue !== CODEX_STANDARD_SERVICE_TIER_ID && currentValue !== fastTier.id) {
    return null;
  }
  return {
    descriptorId: serviceTier.id,
    enabled: currentValue === fastTier.id,
    onValue: fastTier.id,
    offValue: CODEX_STANDARD_SERVICE_TIER_ID,
  };
}

/** Whether a catalog model offers a fast mode, for the model list's bolt marker. */
export function modelSupportsFastMode(
  provider: ProviderDriverKind,
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  const descriptors = capabilities?.optionDescriptors ?? [];
  if (descriptors.some((descriptor) => descriptor.id === "fastMode")) return true;
  return (
    provider === "codex" &&
    descriptors.some(
      (descriptor) =>
        descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        descriptor.options.some(({ label }) => label === "Fast"),
    )
  );
}

/**
 * Copy the effort and fast-mode values from the model's default descriptors
 * onto the current ones, leaving every other option (context window, agent)
 * as the user set it.
 */
export function resetEffortAndFastMode(input: {
  current: ReadonlyArray<ProviderOptionDescriptor>;
  defaults: ReadonlyArray<ProviderOptionDescriptor>;
  descriptorIds: ReadonlyArray<string>;
}): ReadonlyArray<ProviderOptionDescriptor> {
  return input.current.map((descriptor) => {
    if (!input.descriptorIds.includes(descriptor.id)) return descriptor;
    const fallback = input.defaults.find((candidate) => candidate.id === descriptor.id);
    const defaultValue = getProviderOptionCurrentValue(fallback);
    if (descriptor.type === "boolean") {
      return { ...descriptor, currentValue: defaultValue === true };
    }
    if (typeof defaultValue === "string") {
      return { ...descriptor, currentValue: defaultValue };
    }
    const { currentValue: _unused, ...rest } = descriptor;
    return rest;
  });
}

/** True when effort and fast mode already hold the model's defaults (reset has nothing to do). */
export function isEffortAndFastModeAtDefaults(input: {
  current: ReadonlyArray<ProviderOptionDescriptor>;
  defaults: ReadonlyArray<ProviderOptionDescriptor>;
  descriptorIds: ReadonlyArray<string>;
}): boolean {
  return input.descriptorIds.every((id) => {
    const current = getProviderOptionCurrentValue(input.current.find((d) => d.id === id));
    const fallback = getProviderOptionCurrentValue(input.defaults.find((d) => d.id === id));
    // An unset boolean means off, the same as an explicit false.
    return (current ?? false) === (fallback ?? false);
  });
}
