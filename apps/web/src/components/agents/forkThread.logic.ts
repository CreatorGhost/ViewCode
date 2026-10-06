/** "Fork of <title>", without stacking prefixes on a fork of a fork (mirrors the server). */
export function forkThreadTitle(sourceTitle: string): string {
  const base = sourceTitle.trim().replace(/^(Fork of )+/, "");
  return `Fork of ${base.length > 0 ? base : "thread"}`;
}
