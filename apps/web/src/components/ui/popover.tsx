"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

// Popovers hold prose and forms, so a width is fixed rather than a minimum,
// and every width is capped to the viewport.
const popoverPopupWidthClassName = {
  auto: "",
  sm: "w-64",
  md: "w-80",
  lg: "w-96",
} as const;

// The inset around the content. "compact" suits dense content (a list, a code excerpt, a
// row of reactions); "none" is for content that draws its own frame edge to edge.
const popoverViewportPaddingClassName = {
  default: "py-4 [--viewport-inline-padding:--spacing(4)]",
  compact: "py-2 [--viewport-inline-padding:--spacing(3)]",
  // Rounded to the popup so edge-to-edge content clips to its corners.
  none: "rounded-[calc(var(--radius-lg)-1px)] py-0 [--viewport-inline-padding:0px]",
} as const;

// "floating" is a rounder sheet with a caret pointing at its trigger, for compact
// control panels that hang off a pill (the composer's model and usage popovers).
const popoverPopupVariantClassName = {
  default: "rounded-lg before:rounded-[calc(var(--radius-lg)-1px)]",
  floating: "rounded-3xl before:rounded-[calc(var(--radius-3xl)-1px)]",
} as const;

function PopoverPopup({
  children,
  className,
  padding = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  keepMounted = false,
  anchor,
  variant = "default",
  ...props
}: PopoverPrimitive.Popup.Props & {
  variant?: keyof typeof popoverPopupVariantClassName;
  padding?: keyof typeof popoverViewportPaddingClassName;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  tooltipStyle?: boolean;
  keepMounted?: PopoverPrimitive.Portal.Props["keepMounted"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  width?: keyof typeof popoverPopupWidthClassName;
}) {
  // Viewport rekeys its children when the active trigger clears on close. Persistent
  // single-trigger forms need a stable container to retain drafts and submit guards.
  const Viewport = keepMounted ? "div" : PopoverPrimitive.Viewport;
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none"
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            popoverPopupVariantClassName[variant],
            tooltipStyle &&
              "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
            !tooltipStyle &&
              "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            width !== "auto" && ["max-w-[calc(100vw-2rem)]", popoverPopupWidthClassName[width]],
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              tooltipStyle && padding === "default"
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : popoverViewportPaddingClassName[padding],
              variant === "floating" && "rounded-[calc(var(--radius-3xl)-1px)]",
              !tooltipStyle && "not-data-transitioning:overflow-y-auto",
            )}
            data-slot="popover-viewport"
          >
            {children}
          </Viewport>
          {variant === "floating" ? (
            // The caret sits just outside the popup edge and overlaps its border by a pixel,
            // so its fill hides the border line where the two meet.
            <PopoverPrimitive.Arrow
              className="pointer-events-none flex h-2 w-4 data-[side=bottom]:bottom-full data-[side=bottom]:mb-[-1px] data-[side=bottom]:rotate-180 data-[side=top]:top-full data-[side=top]:mt-[-1px]"
              data-slot="popover-arrow"
            >
              <svg viewBox="0 0 16 8" className="size-full overflow-visible" aria-hidden="true">
                <path d="M0 0 L8 8 L16 0" className="fill-popover stroke-foreground/10" />
              </svg>
            </PopoverPrimitive.Arrow>
          ) : null}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-sm leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverClose,
};
