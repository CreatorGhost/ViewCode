const DIFF_COUNT_FORMAT = new Intl.NumberFormat();

export function formatDiffCount(count: number): string {
  return DIFF_COUNT_FORMAT.format(count);
}

export type DiffstatBlock = "addition" | "deletion" | "neutral";

const BLOCKS = 5;

/**
 * The diff chip's five blocks, as GitHub draws a diffstat: more of them fill as the change grows
 * (one for a few lines, all five past a few thousand), split between additions and deletions,
 * and each side that changed gets at least one.
 */
export function diffstatBlocks(additions: number, deletions: number): ReadonlyArray<DiffstatBlock> {
  const total = additions + deletions;
  const filled =
    total === 0 ? 0 : Math.min(BLOCKS, Math.max(1, Math.round(Math.log10(total + 1) * 1.5)));
  let added = Math.round((filled * additions) / Math.max(total, 1));
  if (deletions > 0 && added === filled && filled > 1) added -= 1;
  if (additions > 0 && added === 0 && filled > 1) added = 1;
  const deleted = deletions > 0 ? filled - added : 0;
  return [
    ...Array.from({ length: added }, () => "addition" as const),
    ...Array.from({ length: deleted }, () => "deletion" as const),
    ...Array.from({ length: BLOCKS - added - deleted }, () => "neutral" as const),
  ];
}
