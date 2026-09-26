const COLORS = [
  "text-sky-600 dark:text-sky-400",
  "text-violet-600 dark:text-violet-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-600 dark:text-amber-400",
  "text-pink-600 dark:text-pink-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-orange-600 dark:text-orange-400",
  "text-indigo-600 dark:text-indigo-400",
] as const;

/** Stable roster order keeps existing identities unchanged when new agents arrive. */
export function subagentColors(ids: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<number>();
  for (const id of ids) {
    if (colors.has(id)) continue;
    let hash = 0;
    for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    let index = hash % COLORS.length;
    // Avoid identical colors within a small fleet, even when IDs hash alike.
    if (used.size < COLORS.length) {
      while (used.has(index)) index = (index + 1) % COLORS.length;
    }
    used.add(index);
    colors.set(id, COLORS[index]!);
  }
  return colors;
}
