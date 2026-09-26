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
 * Max, and anything a model offers above it (Ultracode, Ultrathink), gets the
 * warm "peak" treatment. Without a Max stop only the highest stop does. A
 * single stop is never a peak.
 */
export type EffortTier = "standard" | "peak";

export function effortTierForIndex(
  index: number,
  stops: ReadonlyArray<Pick<EffortStop, "id">>,
): EffortTier {
  if (stops.length <= 1 || index < 0) return "standard";
  const maxIndex = stops.findIndex(({ id }) => id.toLowerCase() === "max");
  const peakFrom = maxIndex >= 0 ? maxIndex : stops.length - 1;
  return index >= peakFrom ? "peak" : "standard";
}

/**
 * How far along the blue ramp a standard stop sits: 0 at the lowest effort,
 * 1 at the last stop before the peak. Peak stops are 1 (they switch to coral).
 */
export function effortRampForIndex(
  index: number,
  stops: ReadonlyArray<Pick<EffortStop, "id">>,
): number {
  if (stops.length <= 1 || index <= 0) return 0;
  const maxIndex = stops.findIndex(({ id }) => id.toLowerCase() === "max");
  const peakFrom = maxIndex >= 0 ? maxIndex : stops.length - 1;
  if (index >= peakFrom || peakFrom <= 1) return 1;
  return index / (peakFrom - 1);
}

/** The ramp colour for a standard stop, from light sky blue to deep blue. */
export function effortRampColor(ramp: number): string {
  const percent = Math.round(Math.min(Math.max(ramp, 0), 1) * 100);
  return `color-mix(in oklab, var(--effort-low), var(--effort-high) ${percent}%)`;
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
