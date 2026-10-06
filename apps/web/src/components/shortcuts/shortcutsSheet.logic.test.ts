import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildShortcutSheetRows, filterShortcutSheetRows } from "./shortcutsSheet.logic";

const rule = (command: string, key: string, modKey = false) =>
  ({
    command,
    shortcut: {
      key,
      modKey,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    },
  }) as unknown as ResolvedKeybindingsConfig[number];

describe("shortcuts sheet rows", () => {
  const rows = buildShortcutSheetRows(
    [rule("terminal.toggle", "j", true), rule("diff.toggle", "d", true)],
    "Linux",
  );

  it("sorts by label and formats keys", () => {
    expect(rows.map((row) => row.label)).toEqual(["Diff: Toggle", "Terminal: Toggle"]);
    expect(rows[0]?.keys).toBe("Ctrl+D");
  });

  it("filters by label or keys, all terms required", () => {
    expect(filterShortcutSheetRows(rows, "term tog")).toHaveLength(1);
    expect(filterShortcutSheetRows(rows, "ctrl+d")).toHaveLength(1);
    expect(filterShortcutSheetRows(rows, "")).toHaveLength(2);
    expect(filterShortcutSheetRows(rows, "nope")).toHaveLength(0);
  });
});
