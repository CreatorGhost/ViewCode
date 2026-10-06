import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { stepChangeIndex } from "./diffNav.logic";

/**
 * Next/previous changed file and the jump-to-file picker for the diff panel.
 * The panel is only mounted while the diff is open, so `diffOpen` is true for
 * the keybinding `when` clauses.
 */
export function useDiffNavigation(paths: ReadonlyArray<string>, reveal: (path: string) => void) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [jumpOpen, setJumpOpen] = useState(false);
  const currentRef = useRef<number | null>(null);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  const step = useCallback(
    (direction: 1 | -1) => {
      const list = pathsRef.current;
      const next = stepChangeIndex(currentRef.current, list.length, direction);
      const path = list[next];
      if (path === undefined) return;
      currentRef.current = next;
      reveal(path);
    },
    [reveal],
  );

  const jump = useCallback(
    (path: string) => {
      const index = pathsRef.current.indexOf(path);
      if (index >= 0) currentRef.current = index;
      reveal(path);
    },
    [reveal],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          diffOpen: true,
          terminalFocus: isTerminalFocused(),
          editableFocus: isEditableFocused(event.target),
        },
      });
      if (command === "diff.change.next") step(1);
      else if (command === "diff.change.previous") step(-1);
      else if (command === "diff.file.jump") setJumpOpen(true);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, step]);

  return { step, jump, jumpOpen, setJumpOpen };
}
