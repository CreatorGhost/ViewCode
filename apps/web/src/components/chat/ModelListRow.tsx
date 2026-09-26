import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { ArrowRightLeftIcon, CheckIcon, StarIcon, ZapIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  /** Picking this model continues the thread on another provider via a handoff. */
  showHandoffBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
  /**
   * `flat` is the composer popover's row: provider icon on the left, the model
   * over its provider, and fast-mode and selection marks on the right.
   */
  variant?: "default" | "flat";
  supportsFastMode?: boolean;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const favoriteButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="-mr-1 shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleFavorite();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
            disabled={Boolean(props.disabledReason)}
            aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <StarIcon
              className={cn("size-3.5 sm:size-3", props.isFavorite && "fill-current text-warning")}
            />
          </Button>
        }
      />
      <TooltipPopup side="top" align="center">
        {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
      </TooltipPopup>
    </Tooltip>
  );
  const handoffMarker = props.showHandoffBadge ? (
    <ArrowRightLeftIcon
      role="img"
      aria-label="Switches with a context handoff"
      className="size-3 shrink-0 text-muted-foreground"
    />
  ) : null;
  const unavailableBadge = props.unavailable ? (
    <Badge variant="outline" size="sm">
      Unavailable
    </Badge>
  ) : null;

  const row =
    props.variant === "flat" ? (
      <ComboboxItem
        hideIndicator
        index={props.index}
        value={modelPickerModelKey(props.instanceId, props.model.slug)}
        disabled={Boolean(props.disabledReason)}
        variant="card"
        className={cn(
          "group relative w-full !min-w-0 max-w-full cursor-pointer",
          props.disabledReason &&
            "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
        )}
      >
        {ProviderIcon ? (
          <ProviderIcon className="size-4 shrink-0 opacity-60 grayscale" aria-hidden="true" />
        ) : null}
        <div className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 truncate text-sm font-medium leading-snug">
              {getDisplayModelName(props.model, { preferShortName: true })}
            </div>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
            {handoffMarker}
            {unavailableBadge}
          </div>
          <div className="truncate text-xs leading-snug text-muted-foreground">{providerLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {props.isFavorite ? null : (
            <span className="hidden group-hover:contents group-data-highlighted:contents">
              {favoriteButton}
            </span>
          )}
          {props.isFavorite ? favoriteButton : null}
          {props.supportsFastMode ? (
            <ZapIcon
              role="img"
              aria-label="Supports fast mode"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
          <CheckIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0", !props.isSelected && "invisible")}
          />
        </div>
      </ComboboxItem>
    ) : (
      <ComboboxItem
        hideIndicator
        index={props.index}
        value={modelPickerModelKey(props.instanceId, props.model.slug)}
        disabled={Boolean(props.disabledReason)}
        className={cn(
          "group relative w-full !min-w-0 max-w-full cursor-pointer",
          props.disabledReason &&
            "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
        )}
      >
        <div className="min-w-0 flex-1 text-left">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 truncate text-xs font-medium leading-snug">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </div>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
            {handoffMarker}
            {unavailableBadge}
          </div>
          {props.showProvider && (
            <div className="mt-1 flex items-center gap-1.5">
              {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
              <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
                {providerLabel}
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {props.showSelection && props.isSelected ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : null}
          {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
          {favoriteButton}
        </div>
      </ComboboxItem>
    );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
