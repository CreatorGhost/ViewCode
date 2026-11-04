import { ANTIGRAVITY_DEFAULT_MODEL } from "@t3tools/contracts";
import { useEffect } from "react";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import {
  getTriggerDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";
export function resolveModelPickerTrigger(input: {
  activeEntry: ProviderInstanceEntry | null;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  const { activeEntry, model, options } = input;
  // Account-specific catalogs must keep the selected model label while unavailable.
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model,
      options,
    }) ??
    (activeEntry?.driverKind === "opencode" || activeEntry?.driverKind === "antigravity"
      ? undefined
      : options[0]);
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel)
    : model === ANTIGRAVITY_DEFAULT_MODEL
      ? "Choose model"
      : model || "Choose model";
  const triggerLabel = selectedModel
    ? `${getTriggerDisplayModelLabel(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : triggerTitle;
  return { selectedModel, triggerTitle, triggerLabel };
}

/**
 * While a model picker is open, keep wheel and touch scrolling inside its list
 * (`[data-model-picker-content]`) instead of scrolling the page behind it.
 */
export function useModelPickerScrollLock(open: boolean) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [open]);
}
