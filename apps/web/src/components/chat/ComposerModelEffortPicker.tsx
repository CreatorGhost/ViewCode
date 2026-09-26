import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { Slider } from "@base-ui/react/slider";
import { memo, useMemo } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RotateCcwIcon,
  ZapIcon,
} from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { shortcutLabelForCommand } from "../../keybindings";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  buildEffortStops,
  effortTierForIndex,
  findEffortDescriptor,
  isEffortAndFastModeAtDefaults,
  resetEffortAndFastMode,
  resolveEffortStopIndex,
  resolveFastModeControl,
} from "./composerModelEffort.logic";
import { resolveComposerTraitsOptions } from "./composerProviderState";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { resolveModelPickerTrigger, useModelPickerScrollLock } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";
import { type TraitsPersistence, useTraitsController } from "./TraitsPicker";

export type ComposerModelEffortView = "effort" | "model";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The traits half of the picker: the selected model's options and where they persist. */
export type ComposerModelEffortTraits = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  /** The selected model slug as the draft stores it (the picker may show a normalized one). */
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  planModeEnabled: boolean;
};

/**
 * The composer's single model + effort control: a tinted pill showing the
 * provider, short model name and effort, opening a popover with an effort
 * slider (and fast mode) that can flip to a flat model list.
 */
export const ComposerModelEffortPicker = memo(function ComposerModelEffortPicker(props: {
  activeInstanceId: ProviderInstanceId;
  /** The model as the picker resolves it against the instance's options. */
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  handoffFromContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  traits: ComposerModelEffortTraits;
  activeProviderIconClassName?: string;
  size?: ComposerControlSize;
  disabled?: boolean;
  terminalOpen?: boolean;
  /** Which view is showing, or null while closed. */
  view: ComposerModelEffortView | null;
  onViewChange: (view: ComposerModelEffortView | null) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** Shift-select adds a model to a multi-model draft. */
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const { traits, view, onViewChange } = props;
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const open = view !== null;
  useModelPickerScrollLock(view === "model");

  const activeEntry = useMemo(
    () =>
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null,
    [props.activeInstanceId, props.instanceEntries],
  );
  const { selectedModel, triggerTitle } = resolveModelPickerTrigger({
    activeEntry,
    model: props.model,
    options: props.modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const persistence: TraitsPersistence = traits.threadRef
    ? { threadRef: traits.threadRef }
    : traits.draftId
      ? { draftId: traits.draftId }
      : {};
  const hasTraitsTarget = traits.threadRef !== undefined || traits.draftId !== undefined;
  const { selections, defaultDescriptors } = resolveComposerTraitsOptions({
    provider: traits.provider,
    model: traits.model,
    models: traits.models,
    modelOptions: traits.modelOptions,
    planModeEnabled: traits.planModeEnabled,
  });
  const controller = useTraitsController({
    provider: traits.provider,
    instanceId: traits.instanceId,
    models: traits.models,
    model: traits.model,
    prompt: traits.prompt,
    onPromptChange: traits.onPromptChange,
    modelOptions: selections,
    planModeEnabled: traits.planModeEnabled,
    persistence,
  });
  const descriptors = hasTraitsTarget ? controller.descriptors : [];
  const effortDescriptor = findEffortDescriptor(descriptors);
  const effortStops = buildEffortStops(effortDescriptor);
  const currentEffortValue = getProviderOptionCurrentValue(effortDescriptor);
  const effortValue = controller.ultrathinkPromptControlled
    ? "ultrathink"
    : typeof currentEffortValue === "string"
      ? currentEffortValue
      : null;
  const effortIndex = resolveEffortStopIndex(effortDescriptor, effortValue);
  const effortLabel = effortIndex >= 0 ? (effortStops[effortIndex]?.label ?? null) : null;
  const effortTier = effortTierForIndex(effortIndex, effortStops);
  const fastMode = resolveFastModeControl(traits.provider, descriptors);
  const resetIds = [
    ...(effortDescriptor ? [effortDescriptor.id] : []),
    ...(fastMode ? [fastMode.descriptorId] : []),
  ];
  const atDefaults =
    !controller.ultrathinkPromptControlled &&
    isEffortAndFastModeAtDefaults({
      current: descriptors,
      defaults: defaultDescriptors,
      descriptorIds: resetIds,
    });
  const readOnly = controller.modelIsUnavailable;
  const effortLocked = readOnly || controller.ultrathinkInBodyText;
  const otherDescriptors = descriptors.filter(
    (descriptor) =>
      descriptor.id !== effortDescriptor?.id && descriptor.id !== fastMode?.descriptorId,
  );

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const accessibleLabel = [
    triggerTitle,
    effortLabel,
    fastMode?.enabled ? "Fast mode on" : null,
    selectedModel?.isUnavailable ? "Unavailable" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const providerIcon = activeEntry ? (
    <ProviderInstanceIcon
      driverKind={activeEntry.driverKind}
      displayName={activeEntry.displayName}
      accentColor={activeEntry.accentColor}
      showBadge={showInstanceBadge}
      className="size-4"
      iconClassName={cn("size-4", props.activeProviderIconClassName)}
      indicatorBackground="var(--popover)"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  ) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          onViewChange(null);
          return;
        }
        onViewChange(nextOpen ? (view ?? "effort") : null);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={accessibleLabel}
                  disabled={props.disabled}
                  data-chat-provider-model-picker="true"
                  data-composer-shortcut="composer.effort"
                  className={cn(
                    "inline-flex min-w-13 shrink cursor-pointer items-center whitespace-nowrap rounded-full bg-primary/15 text-foreground outline-none transition-colors hover:bg-primary/22 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-primary/22",
                    size === "xs" ? "h-7 gap-1 px-2 text-xs sm:h-6" : "h-8 gap-1.5 px-3 text-sm",
                  )}
                />
              }
            />
          }
        >
          {providerIcon}
          <span
            data-chat-provider-model-picker-label="true"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden"
          >
            <span className="min-w-0 truncate">{triggerTitle}</span>
            {fastMode?.enabled ? (
              <ZapIcon aria-hidden="true" className="size-3 shrink-0 fill-current text-primary" />
            ) : null}
            {effortLabel ? (
              <span
                className={cn(
                  "shrink-0 text-muted-foreground",
                  effortTier === "peak" && "text-effort-peak",
                )}
              >
                {controller.ultrathinkPromptControlled ? "Ultrathink" : effortLabel}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {shortcutLabel ? `${accessibleLabel} · ${shortcutLabel}` : accessibleLabel}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...composerFloatingLayerProps}
        side="top"
        align="center"
        sideOffset={10}
        padding="none"
        variant="floating"
      >
        <div className="w-80 max-w-[calc(100vw-2rem)]">
          {view === "model" ? (
            <div className="flex flex-col">
              <div className="flex items-center gap-1 px-2 pt-2">
                <button
                  type="button"
                  aria-label="Back to effort"
                  onClick={() => onViewChange("effort")}
                  className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeftIcon className="size-4" aria-hidden="true" />
                </button>
                <span className="font-semibold text-sm">Select model</span>
              </div>
              <ModelPickerContent
                layout="flat"
                activeInstanceId={props.activeInstanceId}
                model={props.model}
                lockedProvider={props.lockedProvider}
                lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
                handoffFromContinuationGroupKey={props.handoffFromContinuationGroupKey ?? null}
                instanceEntries={props.instanceEntries}
                {...(props.keybindings ? { keybindings: props.keybindings } : {})}
                modelOptionsByInstance={props.modelOptionsByInstance}
                terminalOpen={props.terminalOpen ?? false}
                onRequestClose={() => onViewChange(null)}
                {...(props.onOpenProviderSetup
                  ? { onOpenProviderSetup: props.onOpenProviderSetup }
                  : {})}
                {...(props.getModelDisabledReason
                  ? { getModelDisabledReason: props.getModelDisabledReason }
                  : {})}
                {...(props.onToggleModel
                  ? {
                      onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                        if (!props.disabled) props.onToggleModel?.(instanceId, model);
                      },
                    }
                  : {})}
                onInstanceModelChange={(instanceId, model) => {
                  if (props.disabled) return;
                  props.onInstanceModelChange(instanceId, model);
                  onViewChange("effort");
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              <div className="flex items-center justify-between gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Fast mode"
                        aria-pressed={fastMode?.enabled ?? false}
                        disabled={!fastMode || readOnly}
                        onClick={() => {
                          if (!fastMode) return;
                          const next = fastMode.enabled ? fastMode.offValue : fastMode.onValue;
                          if (typeof next === "boolean") {
                            controller.setBooleanOption(fastMode.descriptorId, next);
                            return;
                          }
                          const descriptor = descriptors.find(
                            (candidate): candidate is SelectDescriptor =>
                              candidate.id === fastMode.descriptorId && candidate.type === "select",
                          );
                          if (descriptor) controller.selectOption(descriptor, next);
                        }}
                        className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground/8 text-muted-foreground outline-none transition-colors hover:bg-foreground/12 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                      />
                    }
                  >
                    <ZapIcon
                      aria-hidden="true"
                      className={cn("size-4.5", fastMode?.enabled && "fill-current")}
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {!fastMode
                      ? "Fast mode isn't available for this model"
                      : fastMode.enabled
                        ? "Fast mode on"
                        : "Fast mode off"}
                  </TooltipPopup>
                </Tooltip>
                <button
                  type="button"
                  aria-label={`Change model (${triggerTitle})`}
                  onClick={() => onViewChange("model")}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-0.5 rounded-2xl px-2 py-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-0.5 font-semibold text-xl leading-tight",
                      effortLabel === null
                        ? "text-foreground"
                        : effortTier === "peak"
                          ? "text-effort-peak"
                          : "text-primary",
                    )}
                  >
                    <span className="truncate">
                      {controller.ultrathinkPromptControlled
                        ? "Ultrathink"
                        : (effortLabel ?? triggerTitle)}
                    </span>
                    <ChevronRightIcon aria-hidden="true" className="size-5 shrink-0" />
                  </span>
                  <span className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
                    {providerIcon}
                    <span className="truncate">{triggerTitle}</span>
                  </span>
                </button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="Reset effort to default"
                        disabled={resetIds.length === 0 || atDefaults || effortLocked}
                        onClick={() => {
                          controller.clearPromptInjectedEffort();
                          controller.updateDescriptors(
                            resetEffortAndFastMode({
                              current: descriptors,
                              defaults: defaultDescriptors,
                              descriptorIds: resetIds,
                            }),
                          );
                        }}
                        className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground/8 text-muted-foreground outline-none transition-colors hover:bg-foreground/12 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
                      />
                    }
                  >
                    <RotateCcwIcon aria-hidden="true" className="size-4" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Reset to the model's defaults</TooltipPopup>
                </Tooltip>
              </div>

              {effortDescriptor && effortStops.length > 1 ? (
                <EffortSlider
                  label={effortDescriptor.label}
                  stops={effortStops}
                  index={effortIndex}
                  peak={effortTier === "peak"}
                  disabled={effortLocked}
                  onIndexChange={(index) => {
                    const stop = effortStops[index];
                    if (stop) controller.selectOption(effortDescriptor, stop.id);
                  }}
                />
              ) : null}
              {controller.ultrathinkInBodyText ? (
                <p className="text-muted-foreground text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change the
                  effort.
                </p>
              ) : null}
              {!hasTraitsTarget || (!effortDescriptor && otherDescriptors.length === 0) ? (
                <p className="text-center text-muted-foreground text-xs">
                  This model has no effort levels.
                </p>
              ) : null}

              {otherDescriptors.length > 0 ? (
                <div className="flex flex-col gap-2.5 border-border/70 border-t pt-3">
                  {otherDescriptors.map((descriptor) => (
                    <div key={descriptor.id} className="flex items-center justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {descriptor.label}
                      </span>
                      {descriptor.type === "boolean" ? (
                        <Switch
                          size="sm"
                          aria-label={descriptor.label}
                          checked={descriptor.currentValue === true}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            controller.setBooleanOption(descriptor.id, checked)
                          }
                        />
                      ) : (
                        <ToggleGroup
                          aria-label={descriptor.label}
                          variant="segmented"
                          className="flex-wrap justify-end"
                          disabled={readOnly}
                          value={[String(getProviderOptionCurrentValue(descriptor) ?? "")]}
                          onValueChange={(next) => {
                            const value = next[0];
                            if (typeof value === "string") {
                              controller.selectOption(descriptor, value);
                            }
                          }}
                        >
                          {descriptor.options.map((option) => (
                            <Toggle key={option.id} value={option.id}>
                              {option.label}
                            </Toggle>
                          ))}
                        </ToggleGroup>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

/**
 * A pill track with a dot per effort stop. The fill runs from the left edge to
 * the thumb; the peak stop turns it coral over a static sparkle scatter.
 */
function EffortSlider(props: {
  label: string;
  stops: ReadonlyArray<{ id: string; label: string }>;
  index: number;
  peak: boolean;
  disabled: boolean;
  onIndexChange: (index: number) => void;
}) {
  const lastIndex = props.stops.length - 1;
  return (
    <Slider.Root
      value={Math.max(props.index, 0)}
      min={0}
      max={lastIndex}
      step={1}
      thumbAlignment="edge"
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== props.index) props.onIndexChange(value);
      }}
      className="w-full data-disabled:opacity-64"
    >
      <Slider.Control className="relative flex h-11 w-full cursor-pointer touch-none items-center select-none data-disabled:cursor-not-allowed">
        <Slider.Track
          data-peak={props.peak || undefined}
          className="relative h-9 w-full rounded-full bg-foreground/10 data-peak:bg-effort-sparkles"
        >
          <Slider.Indicator
            // Kept out of cn(): tailwind-merge would read the sparkle image as a
            // second background colour and drop one of the two.
            className={
              props.peak
                ? "rounded-full bg-effort-peak bg-effort-sparkles"
                : "rounded-full bg-primary"
            }
          />
          {props.stops.map((stop, index) => (
            <span
              key={stop.id}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 size-1.5 -translate-1/2 rounded-full",
                index <= props.index ? "bg-primary-foreground/70" : "bg-foreground/35",
              )}
              // Stop centres match the thumb's edge-aligned travel (a 44px thumb).
              style={{ left: `calc(1.375rem + (100% - 2.75rem) * ${index / lastIndex})` }}
            />
          ))}
          <Slider.Thumb
            aria-label={props.label}
            getAriaValueText={(_formatted, value) => props.stops[value]?.label ?? String(value)}
            className="size-11 rounded-full border border-foreground/20 bg-foreground/15 shadow-md outline-none backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
