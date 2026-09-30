import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

/**
 * Agent-facing view of the composer picker's effort and fast-mode controls.
 * The descriptor ids and the Codex service-tier mapping mirror
 * `apps/web/src/components/chat/composerModelEffort.logic.ts`, so an agent
 * sets exactly what the user would pick in the picker.
 */
type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

const EFFORT_DESCRIPTOR_IDS = ["effort", "reasoningEffort", "reasoning", "variant"] as const;
const CODEX_STANDARD_SERVICE_TIER_ID = "default";
// Ultracode is a separate switch in the picker, not an effort level.
const ULTRACODE_EFFORT = "ultracode";

export interface EffortLevel {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean;
}

export interface ModelTuning {
  readonly effortLevels?: ReadonlyArray<EffortLevel>;
  readonly fastMode?: boolean;
}

const findEffort = (descriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
  for (const id of EFFORT_DESCRIPTOR_IDS) {
    const found = descriptors.find(
      (candidate): candidate is SelectDescriptor =>
        candidate.type === "select" && candidate.id === id && candidate.options.length > 0,
    );
    if (found) return found;
  }
  return null;
};

const effortLevels = (descriptor: SelectDescriptor): ReadonlyArray<EffortLevel> => {
  const injected = descriptor.promptInjectedValues ?? [];
  return descriptor.options
    .filter(({ id }) => id !== ULTRACODE_EFFORT && !injected.includes(id))
    .map(({ id, label, isDefault }) => ({ id, label, ...(isDefault ? { isDefault } : {}) }));
};

const findFastMode = (driver: string, descriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
  const boolean = descriptors.find((d) => d.id === "fastMode" && d.type === "boolean");
  if (boolean) return { descriptorId: boolean.id, onValue: true, offValue: false } as const;
  if (driver !== "codex") return null;
  const tier = descriptors.find(
    (d): d is SelectDescriptor => d.id === "serviceTier" && d.type === "select",
  );
  const fast = tier?.options.find(({ label }) => label === "Fast");
  if (!tier || !fast) return null;
  return {
    descriptorId: tier.id,
    onValue: fast.id,
    offValue: CODEX_STANDARD_SERVICE_TIER_ID,
  } as const;
};

/** What an agent may tune on a model, for viewcode_list_models. */
export const describeModelTuning = (
  driver: string,
  capabilities: ModelCapabilities | null | undefined,
): ModelTuning => {
  const descriptors = capabilities?.optionDescriptors ?? [];
  const effort = findEffort(descriptors);
  const levels = effort ? effortLevels(effort) : [];
  return {
    ...(levels.length > 0 ? { effortLevels: levels } : {}),
    ...(findFastMode(driver, descriptors) ? { fastMode: true } : {}),
  };
};

/** The effort an agent's stored model options select, or undefined for the model default. */
export const selectedEffort = (
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): string | undefined => {
  for (const id of EFFORT_DESCRIPTOR_IDS) {
    const value = options?.find((option) => option.id === id)?.value;
    if (typeof value === "string") return value;
  }
  return undefined;
};

const validLevels = (levels: ReadonlyArray<EffortLevel>) => levels.map(({ id }) => id).join(", ");

/**
 * The model-selection options for the requested effort and fast mode, layered
 * on the selection's existing options like a picker change. `error` names the
 * valid values when the model cannot take the request.
 */
export const applyModelTuning = (input: {
  readonly driver: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly existing?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly effort?: string | undefined;
  readonly fastMode?: boolean | undefined;
}):
  | { readonly options: ReadonlyArray<ProviderOptionSelection> | undefined }
  | { error: string } => {
  const caps = input.capabilities ?? { optionDescriptors: [] };
  let descriptors = getProviderOptionDescriptors({ caps, selections: input.existing });
  const set = (id: string, value: string | boolean) => {
    descriptors = descriptors.map((d) =>
      d.id === id ? { ...d, currentValue: value } : d,
    ) as ReadonlyArray<ProviderOptionDescriptor>;
  };

  if (input.effort !== undefined) {
    const descriptor = findEffort(descriptors);
    const levels = descriptor ? effortLevels(descriptor) : [];
    if (!descriptor || levels.length === 0) {
      return { error: `Model "${input.model}" has no reasoning effort setting.` };
    }
    const wanted = input.effort
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    const match = levels.find(
      ({ id, label }) =>
        id.toLowerCase().replace(/[\s_-]+/g, "") === wanted ||
        label.toLowerCase().replace(/[\s_-]+/g, "") === wanted,
    );
    if (!match) {
      return {
        error: `Invalid effort "${input.effort}" for model "${input.model}". Valid levels: ${validLevels(levels)}.`,
      };
    }
    set(descriptor.id, match.id);
  }

  if (input.fastMode !== undefined) {
    const fast = findFastMode(input.driver, descriptors);
    if (!fast) return { error: `Model "${input.model}" has no fast mode.` };
    set(fast.descriptorId, input.fastMode ? fast.onValue : fast.offValue);
  }

  return { options: buildProviderOptionSelectionsFromDescriptors(descriptors) };
};
