import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { formatShortcutLabel } from "../../keybindings";
import { commandLabel } from "../settings/KeybindingsSettings.logic";

export interface ShortcutSheetRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly keys: string;
}

/** One row per bound command chord, sorted by label. Unbound commands are left out. */
export function buildShortcutSheetRows(
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): ReadonlyArray<ShortcutSheetRow> {
  const rows = keybindings.map((rule, index) => ({
    id: `${rule.command}:${index}`,
    command: rule.command,
    label: commandLabel(rule.command),
    keys: formatShortcutLabel(rule.shortcut, platform),
  }));
  return rows.toSorted((a, b) => a.label.localeCompare(b.label) || a.keys.localeCompare(b.keys));
}

/** Every whitespace-separated term must appear in the label or the key text. */
export function filterShortcutSheetRows(
  rows: ReadonlyArray<ShortcutSheetRow>,
  query: string,
): ReadonlyArray<ShortcutSheetRow> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = `${row.label} ${row.keys}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
