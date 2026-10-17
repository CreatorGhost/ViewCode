import { CheckIcon, CopyIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { memo, useRef } from "react";
import { Check, Copy } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  DRAFT_COPY_FORMAT_LABELS,
  formatRenderedMessage,
  MESSAGE_COPY_FORMATS,
  type MessageFormat,
} from "~/lib/messageFormats";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CopyFormatMenu } from "./CopyFormatMenu";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon = Copy,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  icon?: typeof Copy;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-primary")}
          icon={isCopied ? Check : icon}
        />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});

const MESSAGE_COPY_FORMAT_STORAGE_KEY = "t3code.messageCopyFormat";
const MessageCopyFormatSchema = Schema.Literals(MESSAGE_COPY_FORMATS);

/**
 * A whole reply's copy button: copies in the format last picked on this device (the
 * reply's Markdown by default), with an arrow for Slack, WhatsApp and plain text. Those
 * convert the rendered reply, which `target` finds; a reply scrolled out of the list's
 * render window has none, and the copy says so instead of falling back to Markdown.
 */
export function ReplyCopyButton({
  markdown,
  target,
}: {
  markdown: string;
  target: () => Element | null;
}) {
  const [format, setFormat] = useLocalStorage(
    MESSAGE_COPY_FORMAT_STORAGE_KEY,
    "markdown",
    MessageCopyFormatSchema,
  );
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  const copy = (as: MessageFormat) => {
    if (as === "markdown") return copyToClipboard(markdown);
    const root = target();
    if (!root) {
      showAnchoredCopyErrorToast(ref, new Error("Scroll to the reply, then copy it again."));
      return;
    }
    copyToClipboard(formatRenderedMessage(root, as));
  };
  const label = format === "markdown" ? "Copy message" : DRAFT_COPY_FORMAT_LABELS[format];

  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              disabled={isCopied}
              onClick={() => copy(format)}
              ref={ref}
              type="button"
              size="xs"
              variant="ghost-muted"
            />
          }
        >
          {isCopied ? (
            <CheckIcon className="size-3 text-primary" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{label}</p>
        </TooltipPopup>
      </Tooltip>
      <CopyFormatMenu
        formats={MESSAGE_COPY_FORMATS}
        value={format}
        onPick={(option) => {
          setFormat(option);
          copy(option);
        }}
      />
    </div>
  );
}
