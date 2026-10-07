import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { buildShortcutSheetRows, filterShortcutSheetRows } from "./shortcutsSheet.logic";
import { useShortcutsSheetStore } from "./shortcutsSheetStore";

/** Searchable list of every bound shortcut. Opens from `shortcuts.open` or the palette. */
export function ShortcutsSheet() {
  const open = useShortcutsSheetStore((state) => state.open);
  const setOpen = useShortcutsSheetStore((state) => state.setOpen);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          editableFocus: isEditableFocused(event.target),
        },
      });
      if (command !== "shortcuts.open") return;
      event.preventDefault();
      event.stopPropagation();
      useShortcutsSheetStore.setState((state) => ({ open: !state.open }));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  const rows = useMemo(() => (open ? buildShortcutSheetRows(keybindings) : []), [open, keybindings]);
  const visible = useMemo(() => filterShortcutSheetRows(rows, query), [rows, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-6">
          <Input
            autoFocus
            placeholder="Search shortcuts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="max-h-[50vh] overflow-y-auto">
            {visible.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span className="min-w-0 truncate">{row.label}</span>
                <Kbd>{row.keys}</Kbd>
              </li>
            ))}
            {visible.length === 0 ? (
              <li className="py-6 text-center text-muted-foreground text-sm">No shortcuts match</li>
            ) : null}
          </ul>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
