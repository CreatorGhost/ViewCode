import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getTraitsSectionVisibility, type TraitsPersistence } from "./TraitsPicker";
type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;
function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export type TraitsControllerInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  persistence: TraitsPersistence;
};

/**
 * The traits state and setters shared by the traits menu and the composer's
 * model/effort popover. Writes go to the draft store (or the caller's
 * `onModelOptionsChange`); the prompt is only read, to notice a typed Ultrathink.
 */
export function useTraitsController({
  provider,
  instanceId,
  models,
  model,
  prompt,
  modelOptions,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  persistence,
}: TraitsControllerInput) {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };
  const visibility = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const { descriptors } = visibility;
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const selectOption = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    // Prompt-injected levels (Ultrathink) are the user's to type; a picker
    // never writes them into the prompt.
    if (!value || descriptor.promptInjectedValues?.includes(value)) return;
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };
  const setBooleanOption = (descriptorId: string, value: boolean) => {
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptorId, value));
  };

  return {
    ...visibility,
    updateDescriptors,
    selectOption,
    setBooleanOption,
  };
}
