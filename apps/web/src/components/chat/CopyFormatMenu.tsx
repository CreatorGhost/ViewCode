import { ChevronDownIcon } from "lucide-react";

import { DRAFT_COPY_FORMAT_LABELS, type DraftCopyFormat } from "../../lib/messageFormats";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";

/**
 * The arrow beside a copy button that copies in another format. Picking one copies in it
 * and, through `onPick`, makes it the button's format. Its items mount only while open.
 */
export function CopyFormatMenu<F extends DraftCopyFormat>(props: {
  readonly formats: ReadonlyArray<F>;
  readonly value: F;
  readonly onPick: (format: F) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" variant="ghost-muted" size="icon-xs" />}
        aria-label="Copy formats"
      >
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup value={props.value}>
          {props.formats.map((option) => (
            <MenuRadioItem
              key={option}
              value={option}
              closeOnClick
              onClick={() => props.onPick(option)}
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
  );
}
