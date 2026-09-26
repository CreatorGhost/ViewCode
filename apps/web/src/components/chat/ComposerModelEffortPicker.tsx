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
import {
  type CSSProperties,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  effortFractionAtPointer,
  effortRampColor,
  effortRampForIndex,
  effortStopForKey,
  effortStopFraction,
  effortTierForIndex,
  findEffortDescriptor,
  isEffortAndFastModeAtDefaults,
  nearestEffortStop,
  offersUltracode,
  resetEffortAndFastMode,
  resolveEffortStopIndex,
  resolveFastModeControl,
  ULTRACODE_EFFORT,
} from "./composerModelEffort.logic";
import { resolveComposerTraitsOptions } from "./composerProviderState";
import {
  drawEffortTrackFrame,
  type EffortBrand,
  effortBrandForDriver,
  effortTrackFrameRate,
  type EffortTrackKind,
  effortTrackKind,
  effortTrackStyle,
  FAST_TITLE,
  rgba,
} from "./effortTrack";
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
    modelOptions: selections,
    planModeEnabled: traits.planModeEnabled,
    persistence,
  });
  const descriptors = hasTraitsTarget ? controller.descriptors : [];
  const effortDescriptor = findEffortDescriptor(descriptors);
  const effortStops = buildEffortStops(effortDescriptor);
  const currentEffortValue = getProviderOptionCurrentValue(effortDescriptor);
  const effortValue = typeof currentEffortValue === "string" ? currentEffortValue : null;
  const ultracodeOn = effortValue === ULTRACODE_EFFORT;
  const effortIndex = resolveEffortStopIndex(effortDescriptor, effortStops, effortValue);
  const effortStopLabel = effortIndex >= 0 ? (effortStops[effortIndex]?.label ?? null) : null;
  const effortLabel = ultracodeOn ? "Ultracode" : effortStopLabel;
  const fastMode = resolveFastModeControl(traits.provider, descriptors);
  const brand = effortBrandForDriver(activeEntry?.driverKind ?? traits.provider);
  const trackKind = effortTrackKind({
    peak: effortTierForIndex(effortIndex, effortStops) === "peak",
    fast: fastMode?.enabled === true,
  });
  const trackStyle = effortTrackStyle(trackKind, brand);
  // Standard levels read in plain white; only the charged looks (brand at the
  // top level, gold in fast mode, the fusion gradient) colour the effort name.
  const effortColor = trackKind === "plain" ? "var(--foreground)" : trackStyle.titleColor;
  const resetIds = [
    ...(effortDescriptor ? [effortDescriptor.id] : []),
    ...(fastMode ? [fastMode.descriptorId] : []),
  ];
  const atDefaults = isEffortAndFastModeAtDefaults({
    current: descriptors,
    defaults: defaultDescriptors,
    descriptorIds: resetIds,
  });
  const readOnly = controller.modelIsUnavailable;
  const otherDescriptors = descriptors.filter(
    (descriptor) =>
      descriptor.id !== effortDescriptor?.id && descriptor.id !== fastMode?.descriptorId,
  );

  const selectEffortStop = (index: number) => {
    const stop = effortStops[index];
    if (effortDescriptor && stop) controller.selectOption(effortDescriptor, stop.id);
  };
  const toggleFastMode = () => {
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
  };

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
          {fastMode?.enabled ? (
            <ZapIcon
              aria-hidden="true"
              className="size-3 shrink-0 fill-current"
              style={{ color: rgba(FAST_TITLE) }}
            />
          ) : null}
          <span
            data-chat-provider-model-picker-label="true"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden"
          >
            {open ? (
              // The chip anchors the popover: while it is open a fixed label keeps
              // its width, so effort changes never shift the popover.
              <span className="min-w-0 truncate">Select effort</span>
            ) : (
              <>
                <span className="min-w-0 truncate">{triggerTitle}</span>
                {effortLabel ? (
                  <span className="shrink-0" style={{ color: effortColor }}>
                    {effortLabel}
                  </span>
                ) : null}
              </>
            )}
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
        {/* Fixed widths per view, so no label change resizes the popover. The model
            view is wider to fit the provider rail beside the list. */}
        <div className={cn("max-w-[calc(100vw-2rem)]", view === "model" ? "w-90" : "w-82.5")}>
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
                layout="sidebar"
                fillContainer
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
            <div className="flex flex-col gap-4 px-4 pt-3.5 pb-4">
              <div className="flex h-11 items-center justify-between gap-2">
                {fastMode ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Fast mode"
                          aria-pressed={fastMode.enabled}
                          disabled={readOnly}
                          onClick={toggleFastMode}
                          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground/8 text-muted-foreground outline-none transition-colors duration-300 hover:bg-foreground/12 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                          style={
                            fastMode.enabled
                              ? { color: rgba(FAST_TITLE), backgroundColor: rgba(FAST_TITLE, 0.16) }
                              : undefined
                          }
                        />
                      }
                    >
                      <ZapIcon
                        aria-hidden="true"
                        className={cn("size-4", fastMode.enabled && "fill-current")}
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {fastMode.enabled ? "Fast mode on" : "Fast mode off"}
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <span aria-hidden="true" className="size-8 shrink-0" />
                )}
                <button
                  type="button"
                  aria-label={`Change model (${triggerTitle})`}
                  onClick={() => onViewChange("model")}
                  className="flex h-11 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl px-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <EffortTitle
                    text={effortLabel ?? "Standard"}
                    rank={ultracodeOn ? effortStops.length : effortIndex}
                    color={effortLabel === null ? "var(--foreground)" : effortColor}
                    gradient={trackStyle.titleGradient}
                  />
                  <span className="flex h-4 min-w-0 items-center gap-1 text-muted-foreground text-xs">
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
                        disabled={resetIds.length === 0 || atDefaults || readOnly}
                        onClick={() => {
                          controller.updateDescriptors(
                            resetEffortAndFastMode({
                              current: descriptors,
                              defaults: defaultDescriptors,
                              descriptorIds: resetIds,
                            }),
                          );
                        }}
                        className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground/8 text-muted-foreground outline-none transition-colors hover:bg-foreground/12 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
                      />
                    }
                  >
                    <RotateCcwIcon aria-hidden="true" className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Reset to default</TooltipPopup>
                </Tooltip>
              </div>

              {effortDescriptor && effortStops.length > 1 ? (
                <EffortSlider
                  label="Reasoning effort"
                  stops={effortStops}
                  index={effortIndex}
                  kind={trackKind}
                  brand={brand}
                  plainColor={effortRampColor(effortRampForIndex(effortIndex, effortStops))}
                  disabled={readOnly}
                  onIndexChange={selectEffortStop}
                />
              ) : (
                <p className="flex h-10.5 items-center justify-center text-muted-foreground text-xs">
                  {hasTraitsTarget ? "This model has one reasoning level." : "No effort levels."}
                </p>
              )}

              {(effortDescriptor && offersUltracode(effortDescriptor)) ||
              otherDescriptors.length > 0 ? (
                <div className="flex flex-col gap-2.5 border-border/70 border-t pt-3">
                  {effortDescriptor && offersUltracode(effortDescriptor) ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground text-xs">Ultracode</span>
                      <Switch
                        size="sm"
                        aria-label="Ultracode"
                        checked={ultracodeOn}
                        disabled={readOnly}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            controller.selectOption(effortDescriptor, ULTRACODE_EFFORT);
                          } else {
                            // Back to the level the slider shows while Ultracode is on.
                            selectEffortStop(effortIndex);
                          }
                        }}
                      />
                    </div>
                  ) : null}
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
 * The header's effort name, in a fixed-height box. A change rolls letter by
 * letter like Droppy's numeric-text transition: the old name slides out with
 * a blur while the new one slides in, upward when `rank` rises and downward
 * when it falls (keyframes in `viewcode-theme.css`). Colour eases over 300ms;
 * a gradient (Gemini, fusion) is clipped to the text.
 */
function EffortTitle(props: {
  text: string;
  rank: number;
  color: string;
  gradient: string | null;
}) {
  const [labels, setLabels] = useState(() => [
    { id: 0, text: props.text, rank: props.rank, roll: 1, animate: false },
  ]);
  const current = labels[labels.length - 1];
  // Drop the outgoing name once its roll has finished, so two names can never
  // stay stacked even if the animation doesn't run.
  const hasOutgoing = labels.length > 1;
  useEffect(() => {
    if (!hasOutgoing) return;
    const timer = window.setTimeout(() => setLabels((all) => all.slice(-1)), 450);
    return () => window.clearTimeout(timer);
  }, [hasOutgoing, current?.id]);
  if (current && current.text !== props.text) {
    const roll = props.rank < current.rank ? -1 : 1;
    setLabels([
      { ...current, roll },
      { id: current.id + 1, text: props.text, rank: props.rank, roll, animate: true },
    ]);
  }
  const style: CSSProperties = props.gradient
    ? { backgroundImage: props.gradient, color: "transparent" }
    : { color: props.color };
  return (
    <span className="flex h-6 w-full min-w-0 items-center justify-center gap-1">
      <span
        className={cn(
          "relative flex min-w-0 justify-center font-medium text-lg leading-6 transition-colors duration-300 ease-out",
          props.gradient && "bg-clip-text",
        )}
        style={style}
      >
        {labels.map((label, position) => {
          const incoming = position === labels.length - 1;
          const letters = Array.from(label.text);
          return (
            <span
              key={label.id}
              aria-hidden={incoming ? undefined : "true"}
              aria-label={incoming ? label.text : undefined}
              className={
                incoming
                  ? "min-w-0 truncate"
                  : "pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap"
              }
              style={{ "--roll": label.roll } as CSSProperties}
            >
              {incoming && !label.animate
                ? label.text
                : letters.map((letter, index) => (
                    <span
                      // oxlint-disable-next-line react/no-array-index-key -- letters are positional
                      key={index}
                      aria-hidden="true"
                      data-viewcode-roll={incoming ? "in" : "out"}
                      style={{ "--i": index } as CSSProperties}
                    >
                      {letter}
                    </span>
                  ))}
            </span>
          );
        })}
      </span>
      <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </span>
  );
}

/** Half the track's height: stop centres sit this far in from each end. */
const TRACK_INSET_PX = 17;

/**
 * A 34px capsule with a dot per effort stop and a 42px glass knob (Droppy's
 * EffortSlider). While dragging, the knob and fill follow the pointer 1:1 and
 * the effort commits as the nearest stop changes; on release the knob springs
 * onto its stop. Position is a CSS variable written straight to the DOM and
 * only transforms move, so a drag repaints this slider alone and a re-render
 * mid-drag cannot snap the knob.
 */
const EffortSlider = memo(function EffortSlider(props: {
  label: string;
  stops: ReadonlyArray<{ id: string; label: string }>;
  index: number;
  kind: EffortTrackKind;
  brand: EffortBrand;
  /** The standard look's solid colour at this level. */
  plainColor: string;
  disabled: boolean;
  onIndexChange: (index: number) => void;
}) {
  const { stops, index, kind, onIndexChange } = props;
  const stopCount = stops.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const draggingRef = useRef(false);
  const committedRef = useRef(index);
  const onIndexChangeRef = useRef(onIndexChange);
  const [dragging, setDragging] = useState(false);
  // Only the first position goes through React; later ones are written directly.
  const [initialPosition] = useState(() => effortStopFraction(index, stopCount));
  const style = effortTrackStyle(kind, props.brand);

  useLayoutEffect(() => {
    onIndexChangeRef.current = onIndexChange;
  }, [onIndexChange]);

  const writePosition = useCallback(
    (fraction: number) => {
      rootRef.current?.style.setProperty("--effort-pos", String(fraction));
      // A stop lights once the knob's centre has reached it.
      dotRefs.current.forEach((dot, stopIndex) => {
        if (!dot) return;
        if (effortStopFraction(stopIndex, stopCount) <= fraction + 1e-6) {
          dot.dataset.passed = "true";
        } else {
          delete dot.dataset.passed;
        }
      });
    },
    [stopCount],
  );

  useLayoutEffect(() => {
    if (draggingRef.current) return;
    committedRef.current = index;
    writePosition(effortStopFraction(index, stopCount));
  }, [index, stopCount, writePosition]);

  // Entering Max or fusion plays one short surge; each entry remounts it.
  const [surge, setSurge] = useState({ kind, count: 0 });
  if (surge.kind !== kind) {
    const entersPeak = kind === "supercharged" || kind === "fusion";
    setSurge({ kind, count: entersPeak ? surge.count + 1 : surge.count });
  }

  const moveTo = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = effortFractionAtPointer({
      clientX,
      trackLeft: rect.left,
      trackWidth: rect.width,
      inset: TRACK_INSET_PX,
    });
    writePosition(fraction);
    const nearest = nearestEffortStop(fraction, stopCount);
    if (nearest !== committedRef.current) {
      committedRef.current = nearest;
      onIndexChangeRef.current(nearest);
    }
  };
  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    writePosition(effortStopFraction(committedRef.current, stopCount));
  };

  const activeIndex = Math.max(index, 0);
  // Following the pointer is 1:1; settling onto a stop is a short spring.
  const moverTransition = dragging
    ? "transition-none"
    : "transition-transform duration-320 ease-settle motion-reduce:transition-none";

  return (
    <div
      ref={rootRef}
      data-disabled={props.disabled || undefined}
      className="relative h-10.5 w-full cursor-pointer touch-none select-none data-disabled:cursor-not-allowed data-disabled:opacity-64"
      style={
        {
          "--effort-pos": initialPosition,
          "--effort-stop-passed": style.stopPassed,
        } as CSSProperties
      }
      onPointerDown={(event) => {
        if (props.disabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
        committedRef.current = index;
        setDragging(true);
        knobRef.current?.focus({ preventScroll: true });
        moveTo(event.clientX);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) moveTo(event.clientX);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div className="absolute inset-x-0 top-1/2 h-8.5 -translate-y-1/2 rounded-full bg-foreground/10">
        <div className="absolute inset-0 overflow-hidden rounded-full">
          {/*
           * The fill is a full-width pill slid left so its right end sits under
           * the knob's far edge; the track clips what slides past the left.
           * Each look is its own layer, crossfaded on opacity: gradients cannot
           * interpolate, solid colours ease on background-color.
           */}
          <div
            className={cn("absolute inset-y-0 left-4.25 right-4.25", moverTransition)}
            style={{ transform: "translateX(calc((var(--effort-pos) - 1) * 100%))" }}
          >
            <div
              className="absolute inset-y-0 -left-4.25 -right-4.25 rounded-full transition-[background-color,opacity] duration-300 ease-out"
              style={{ backgroundColor: props.plainColor, opacity: kind === "plain" ? 1 : 0 }}
            />
            {(["supercharged", "fast", "fusion"] as const).map((layer) => (
              <div
                key={layer}
                aria-hidden="true"
                className="absolute inset-y-0 -left-4.25 -right-4.25 rounded-full transition-opacity duration-300 ease-out"
                style={{
                  background: effortTrackStyle(layer, props.brand).fillBackground,
                  opacity: kind === layer ? 1 : 0,
                }}
              />
            ))}
          </div>
          {kind !== "plain" ? (
            <EffortTrackCanvas
              kind={kind}
              brand={props.brand}
              stopCount={stopCount}
              revision={`${index}:${dragging}`}
              rootRef={rootRef}
              knobRef={knobRef}
            />
          ) : null}
        </div>
        {surge.count > 0 && (kind === "supercharged" || kind === "fusion") ? (
          <div
            key={surge.count}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full animate-effort-surge motion-reduce:hidden"
            style={{ "--effort-surge": style.surge } as CSSProperties}
          />
        ) : null}
        {stops.map((stop, stopIndex) => (
          <span
            key={stop.id}
            ref={(element) => {
              dotRefs.current[stopIndex] = element;
            }}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 size-1.25 -translate-1/2 rounded-full bg-foreground/30 transition-colors duration-300 data-passed:bg-(--effort-stop-passed)"
            style={{
              left: `calc(${TRACK_INSET_PX}px + (100% - ${TRACK_INSET_PX * 2}px) * ${effortStopFraction(stopIndex, stopCount)})`,
            }}
          />
        ))}
      </div>
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-4.25 right-4.25",
          moverTransition,
        )}
        style={{ transform: "translateX(calc(var(--effort-pos) * 100%))" }}
      >
        {/* The glow is a blurred disc beneath the lens, not a shadow on it. */}
        <div
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 left-0 size-10.5 -translate-x-1/2 -translate-y-[calc(50%-1px)] rounded-full transition-[background-color] duration-300 ease-out",
            kind === "plain" ? "blur-xs" : "blur-sm",
          )}
          style={{ backgroundColor: style.glow }}
        />
        <div
          ref={knobRef}
          role="slider"
          tabIndex={props.disabled ? -1 : 0}
          aria-label={props.label}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={stopCount - 1}
          aria-valuenow={activeIndex}
          aria-valuetext={stops[activeIndex]?.label}
          aria-disabled={props.disabled || undefined}
          onKeyDown={(event) => {
            if (props.disabled) return;
            const next = effortStopForKey(event.key, activeIndex, stopCount);
            if (next === null) return;
            event.preventDefault();
            event.stopPropagation();
            if (next !== activeIndex) onIndexChange(next);
          }}
          className={cn(
            "pointer-events-auto absolute top-1/2 left-0 size-10.5 -translate-1/2 rounded-full border outline-none backdrop-blur-md backdrop-saturate-150 transition-[scale,background-color,border-color] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring",
            dragging && "scale-106",
          )}
          style={{ backgroundColor: style.knobTint, borderColor: style.knobEdge }}
        />
      </div>
    </div>
  );
});

/**
 * The live track effect: sparks, arcs, streaks, bolts, sheen and flare drawn
 * into a canvas clipped to the fill (see effortTrack.ts).
 *
 * This is a deliberate, bounded exception to the "no continuously repainting
 * animations" rule: it exists only while the effort popover is open and the
 * look is not the standard one, is capped at 30fps (sparks alone) or 60fps
 * (streaks and bolts), stops while the page is hidden, and under reduced
 * motion draws a single still frame instead of looping.
 */
function EffortTrackCanvas(props: {
  kind: EffortTrackKind;
  brand: EffortBrand;
  stopCount: number;
  /** Changes when the knob settles somewhere new, for the still frame under reduced motion. */
  revision: string;
  rootRef: RefObject<HTMLDivElement | null>;
  knobRef: RefObject<HTMLDivElement | null>;
}) {
  const { kind, brand, stopCount, rootRef, knobRef, revision } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  // Only the still frame needs redrawing when the knob settles; the loop reads live geometry.
  const stillFrameRevision = reduceMotion ? revision : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const startedAt = performance.now();
    const interval = 1000 / effortTrackFrameRate(kind);
    let pixelWidth = 0;
    let pixelHeight = 0;
    let frame = 0;
    let lastDrawn = 0;

    const draw = (now: number) => {
      const root = rootRef.current;
      const knob = knobRef.current;
      if (!root || !knob) return;
      // Read the live geometry, which includes the knob's settling transition.
      const canvasRect = canvas.getBoundingClientRect();
      const knobRect = knob.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(canvasRect.width * dpr);
      const height = Math.round(canvasRect.height * dpr);
      if (width !== pixelWidth || height !== pixelHeight) {
        canvas.width = width;
        canvas.height = height;
        pixelWidth = width;
        pixelHeight = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasRect.width, canvasRect.height);
      const knobX = knobRect.left + knobRect.width / 2 - canvasRect.left;
      const fillWidth = Math.min(knobX + TRACK_INSET_PX, canvasRect.width);
      const travel = canvasRect.width - TRACK_INSET_PX * 2;
      const passedStopXs: number[] = [];
      for (let stop = 0; stop < stopCount; stop += 1) {
        const x = TRACK_INSET_PX + travel * effortStopFraction(stop, stopCount);
        if (x <= knobX + 0.5) passedStopXs.push(x);
      }
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, fillWidth, canvasRect.height, canvasRect.height / 2);
      ctx.clip();
      drawEffortTrackFrame(ctx, {
        kind,
        brand,
        width: fillWidth,
        height: canvasRect.height,
        time: reduceMotion ? 0 : (now - startedAt) / 1000,
        knobX,
        passedStopXs,
      });
      ctx.restore();
    };

    if (reduceMotion) {
      // One still frame, redrawn only when the knob settles on a new stop.
      if (stillFrameRevision !== null) draw(startedAt);
      return;
    }
    const tick = (now: number) => {
      frame = window.requestAnimationFrame(tick);
      if (now - lastDrawn < interval - 1) return;
      lastDrawn = now;
      draw(now);
    };
    const start = () => {
      if (frame === 0 && !document.hidden) frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibilityChange = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [kind, brand, stopCount, rootRef, knobRef, reduceMotion, stillFrameRevision]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full transition-opacity duration-300 ease-out starting:opacity-0"
    />
  );
}
