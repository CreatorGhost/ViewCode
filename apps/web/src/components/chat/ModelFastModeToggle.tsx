import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";

import { Toggle } from "../ui/toggle";
import { resolveFastModeControl } from "./composerModelEffort.logic";

/**
 * The selection with fast mode turned on or off: the model's own fast-mode option (a boolean, or
 * Codex's service tier) set to its on or off value, every other option kept. Null when the
 * selected model has no fast mode.
 */
export function withFastMode(
  selection: ModelSelection,
  driverKind: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  enabled: boolean,
): ModelSelection | null {
  const control = fastModeControlFor(selection, driverKind, models);
  if (control === null) return null;
  const value = enabled ? control.onValue : control.offValue;
  const options: ProviderOptionSelection[] = [
    ...(selection.options ?? []).filter((option) => option.id !== control.descriptorId),
    { id: control.descriptorId, value },
  ];
  return { ...selection, options };
}

function fastModeControlFor(
  selection: ModelSelection,
  driverKind: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
) {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const descriptors = getProviderOptionDescriptors({ caps, selections: selection.options });
  return resolveFastModeControl(driverKind, descriptors);
}

/**
 * Fast mode beside a model picker that has no traits menu of its own (the review form, the side
 * chat), so a run started there can be fast like the composer's. Shows only for a model that has
 * fast mode.
 */
export function ModelFastModeToggle({
  selection,
  driverKind,
  models,
  disabled,
  onChange,
}: {
  selection: ModelSelection;
  driverKind: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  disabled?: boolean;
  onChange: (next: ModelSelection) => void;
}) {
  const control = fastModeControlFor(selection, driverKind, models);
  if (control === null) return null;
  return (
    <Toggle
      size="xs"
      variant="ghost"
      aria-label="Fast mode"
      pressed={control.enabled}
      disabled={disabled}
      onPressedChange={(pressed) => {
        const next = withFastMode(selection, driverKind, models, pressed);
        if (next !== null) onChange(next);
      }}
    >
      <ZapIcon />
      Fast
    </Toggle>
  );
}
