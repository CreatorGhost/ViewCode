/**
 * One-time move to ViewCode's own look. Desktop and browser profiles keep the
 * theme they had, so an install that ran an earlier build stays on an upstream
 * theme and never sees the ViewCode theme or the glass window. On the first
 * launch of this version, a profile on a non-ViewCode theme is switched to
 * "viewcode"; the previous values are kept so the user can undo it.
 * Runs before first render (main.tsx), so the boot script and useTheme read
 * the new value.
 */

export const LOOK_MIGRATION_KEY = "viewcode:look-migrated:v1";
export const LOOK_MIGRATION_PREVIOUS_KEY = "viewcode:look-previous:v1";
const THEME_KEY = "t3code:theme";
const THEME_HALVES_KEY = "t3code:theme-halves:v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

interface PreviousLook {
  readonly theme: string | null;
  readonly halves: string | null;
}

/** Returns true when the profile was switched (so the caller can offer Undo). */
export function migrateToViewCodeLook(storage: Storage): boolean {
  if (storage.getItem(LOOK_MIGRATION_KEY) !== null) return false;
  storage.setItem(LOOK_MIGRATION_KEY, "1");
  const theme = storage.getItem(THEME_KEY);
  const halves = storage.getItem(THEME_HALVES_KEY);
  // No stored theme means the ViewCode default already applies.
  if (theme === null || theme.startsWith("viewcode")) return false;
  const previous: PreviousLook = { theme, halves };
  storage.setItem(LOOK_MIGRATION_PREVIOUS_KEY, JSON.stringify(previous));
  storage.setItem(THEME_KEY, "viewcode");
  storage.removeItem(THEME_HALVES_KEY);
  return true;
}

/** Puts back the theme the profile had before the migration. */
export function undoViewCodeLookMigration(storage: Storage): void {
  const raw = storage.getItem(LOOK_MIGRATION_PREVIOUS_KEY);
  if (raw === null) return;
  const previous = JSON.parse(raw) as PreviousLook;
  if (previous.theme === null) storage.removeItem(THEME_KEY);
  else storage.setItem(THEME_KEY, previous.theme);
  if (previous.halves === null) storage.removeItem(THEME_HALVES_KEY);
  else storage.setItem(THEME_HALVES_KEY, previous.halves);
  storage.removeItem(LOOK_MIGRATION_PREVIOUS_KEY);
}
