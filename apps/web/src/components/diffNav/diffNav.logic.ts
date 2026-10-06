/** Next/previous index in a list of `count` files, wrapping at both ends. */
export function stepChangeIndex(current: number | null, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current === null || current < 0 || current >= count) {
    return direction === 1 ? 0 : count - 1;
  }
  return (current + direction + count) % count;
}

/** Paths matching every whitespace-separated term, basename matches first. */
export function filterDiffFilePaths(paths: ReadonlyArray<string>, query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...paths];
  const matches = paths.filter((path) => {
    const lower = path.toLowerCase();
    return terms.every((term) => lower.includes(term));
  });
  const baseHit = (path: string) => {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    return terms.every((term) => base.includes(term)) ? 0 : 1;
  };
  return matches.toSorted((a, b) => baseHit(a) - baseHit(b));
}
