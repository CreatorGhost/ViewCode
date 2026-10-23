import type { ReviewFindingSeverity } from "@t3tools/contracts";

export type ReviewIssueGroup<T> = {
  readonly severity: ReviewFindingSeverity;
  readonly items: ReadonlyArray<T>;
};

/**
 * The issue list in runs of one severity, in the order given (`reviewIssueOrder` sorts by
 * severity, so each severity makes one run). The list then names a severity once as a heading
 * instead of badging every row.
 */
export function groupIssuesBySeverity<T>(
  items: ReadonlyArray<T>,
  severityOf: (item: T) => ReviewFindingSeverity,
): ReadonlyArray<ReviewIssueGroup<T>> {
  const groups: Array<{ severity: ReviewFindingSeverity; items: Array<T> }> = [];
  for (const item of items) {
    const severity = severityOf(item);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.severity === severity) {
      last.items.push(item);
    } else {
      groups.push({ severity, items: [item] });
    }
  }
  return groups;
}

/** `file.ts:12`: the file's own name, since the row has no room for its folders. */
export function issueFileLabel(path: string, line: number | undefined): string {
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  return line === undefined ? name : `${name}:${line}`;
}
