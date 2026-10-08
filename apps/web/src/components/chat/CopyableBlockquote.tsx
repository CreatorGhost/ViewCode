import * as Schema from "effect/Schema";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { type ComponentProps, createContext, useContext, useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  DRAFT_COPY_FORMAT_LABELS,
  DRAFT_COPY_FORMATS,
  type DraftCopyFormat,
  draftClipboardPayload,
} from "../../lib/messageFormats";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Set inside a copyable quote: a nested quote is copied with its parent, not on its own. */
const InsideQuoteContext = createContext(false);

const DRAFT_COPY_FORMAT_STORAGE_KEY = "t3code.draftCopyFormat";
const DraftCopyFormatSchema = Schema.Literals(DRAFT_COPY_FORMATS);
const DEFAULT_DRAFT_COPY_FORMAT: DraftCopyFormat = "rich";

/**
 * Copies `root`'s message in the format last picked on this device (rich text by default),
 * with a menu for the others: hover, focus or touch reveals it.
 */
function CopyOverlay(props: { readonly target: () => HTMLElement | null; readonly label: string }) {
  const [format, setFormat] = useLocalStorage(
    DRAFT_COPY_FORMAT_STORAGE_KEY,
    DEFAULT_DRAFT_COPY_FORMAT,
    DraftCopyFormatSchema,
  );
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = (as: DraftCopyFormat) => {
    const root = props.target();
    if (!root) return;
    const { text, flavors } = draftClipboardPayload(root, as);
    void writeTextToClipboard(text, "message", flavors).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  const label = copied
    ? "Copied"
    : format === "rich"
      ? props.label
      : DRAFT_COPY_FORMAT_LABELS[format];

  return (
    <div className="absolute top-0 right-0 flex opacity-0 transition-opacity group-hover/quote:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={label}
              onClick={() => copy(format)}
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={<Button type="button" variant="ghost-muted" size="icon-xs" />}
          aria-label="Copy formats"
        >
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end">
          {/* Picking a format copies in it and makes it the button's format on this device. */}
          <MenuRadioGroup value={format}>
            {DRAFT_COPY_FORMATS.map((option) => (
              <MenuRadioItem
                key={option}
                value={option}
                closeOnClick
                onClick={() => {
                  setFormat(option);
                  copy(option);
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1">{DRAFT_COPY_FORMAT_LABELS[option]}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * A quoted block in a reply (often a drafted message) with its own copy button, shown on
 * hover or focus and always on touch screens.
 */
export function CopyableBlockquote({ children, ...props }: ComponentProps<"blockquote">) {
  const nested = useContext(InsideQuoteContext);
  const quoteRef = useRef<HTMLQuoteElement>(null);
  if (nested) return <blockquote {...props}>{children}</blockquote>;

  return (
    <div className="group/quote relative" data-copyable-quote="">
      <blockquote ref={quoteRef} {...props}>
        <InsideQuoteContext.Provider value>{children}</InsideQuoteContext.Provider>
      </blockquote>
      <CopyOverlay target={() => quoteRef.current} label="Copy quote" />
    </div>
  );
}

/**
 * A drafted message set apart by horizontal rules (see markdown-copy-sections): plain
 * content, with the same copy button as a quote.
 */
export function CopyableSection({ children, ...props }: ComponentProps<"div">) {
  const sectionRef = useRef<HTMLDivElement>(null);
  return (
    <div className="group/quote relative" data-copyable-quote="">
      <div ref={sectionRef} {...props}>
        <InsideQuoteContext.Provider value>{children}</InsideQuoteContext.Provider>
      </div>
      <CopyOverlay target={() => sectionRef.current} label="Copy message" />
    </div>
  );
}
