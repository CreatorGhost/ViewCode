import { CheckIcon, CopyIcon } from "lucide-react";
import { type ComponentProps, createContext, useContext, useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Plain text of a rendered quote, with paragraphs and list items on their own
 * lines and ordered-list numbers kept, so a drafted message pastes as written.
 */
export function blockquoteToPlainText(root: HTMLElement): string {
  const lines: string[] = [];
  const walk = (element: Element) => {
    for (const child of element.children) {
      if (child.tagName === "OL" || child.tagName === "UL") {
        const ordered = child.tagName === "OL";
        const start = ordered ? Number((child as HTMLOListElement).start || 1) : 1;
        [...child.children].forEach((item, index) => {
          const text = (item as HTMLElement).innerText.trim();
          if (text) lines.push(ordered ? `${start + index}. ${text}` : `- ${text}`);
        });
      } else if (child.tagName === "BLOCKQUOTE") {
        walk(child);
      } else {
        const text = (child as HTMLElement).innerText.trim();
        if (text) lines.push(text);
      }
    }
  };
  walk(root);
  return lines.join("\n\n");
}

/** Set inside a copyable quote: a nested quote is copied with its parent, not on its own. */
const InsideQuoteContext = createContext(false);

/** Copies `root`'s text as a message pastes: hover, focus or touch reveals it. */
function CopyOverlay(props: { readonly target: () => HTMLElement | null; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = () => {
    const root = props.target();
    if (!root) return;
    void writeTextToClipboard(blockquoteToPlainText(root), "quote").then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  return (
    <div className="absolute top-0 right-0 opacity-0 transition-opacity group-hover/quote:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={copied ? "Copied" : props.label}
              onClick={copy}
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{copied ? "Copied" : props.label}</TooltipPopup>
      </Tooltip>
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
