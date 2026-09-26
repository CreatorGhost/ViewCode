import type { OrchestrationThread } from "@t3tools/contracts";

export interface HistoryMatch {
  readonly source: string;
  readonly createdAt: string;
  readonly snippet: string;
}

const SNIPPET_RADIUS = 240;

function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => stringsIn(entry, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      stringsIn(entry, depth + 1),
    );
  }
  return [];
}

function snippetAround(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Searches a thread's full record — messages and tool results — for entries
 * containing every query term. Lets a model that took over a conversation
 * recover details that were condensed out of its handoff.
 */
export function searchThreadHistory(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
  query: string,
  limit: number,
): HistoryMatch[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  const entries = [
    ...thread.messages.map((message) => ({
      source: message.role,
      createdAt: message.createdAt,
      text: message.text,
    })),
    ...thread.activities.map((activity) => ({
      source: activity.kind,
      createdAt: activity.createdAt,
      text: [activity.summary, ...stringsIn(activity.payload)].join("\n"),
    })),
  ];
  const scored = entries.flatMap((entry) => {
    const lower = entry.text.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) return [];
    const hits = terms.reduce((total, term) => total + lower.split(term).length - 1, 0);
    return [{ ...entry, hits, index: lower.indexOf(terms[0]!) }];
  });
  return scored
    .toSorted(
      (left, right) => right.hits - left.hits || right.createdAt.localeCompare(left.createdAt),
    )
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      source: entry.source,
      createdAt: entry.createdAt,
      snippet: snippetAround(entry.text, entry.index),
    }));
}
