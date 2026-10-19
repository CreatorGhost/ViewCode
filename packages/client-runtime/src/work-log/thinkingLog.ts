import { collectToolFilePaths } from "@t3tools/shared/toolActivity";

import {
  toolGroupAction,
  workEntryDisplayIndicatesToolFailure,
  type ToolGroupSummaryKind,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

/**
 * The thinking-log look: every step sits on one vertical rail with a small marker, and the
 * steps that touched files or pages list them as chips. This module is the client-neutral part:
 * which marker a step gets and which chips it shows.
 */
export type WorkLogMarkerKind =
  /** A finished step. */
  | "dot"
  /** A finished code or web search. */
  | "search"
  /** A failed step, dimmed on the branch lane. */
  | "dead-end"
  /** The step running now: a ring spinning around a dot. */
  | "live"
  /** Branch work (subagents) that has finished and merged back. */
  | "merged"
  /** The turn finished. */
  | "finish";

export type WorkLogLabelTone = "active" | "done" | "dim";

export function workLogMarker(input: {
  readonly live?: boolean | undefined;
  readonly failed?: boolean | undefined;
  readonly kind?: ToolGroupSummaryKind | undefined;
}): WorkLogMarkerKind {
  if (input.live) return "live";
  if (input.failed) return "dead-end";
  return input.kind === "code-search" || input.kind === "search" ? "search" : "dot";
}

export function workLogEntryMarker(
  entry: WorkLogPresentationEntry,
  live = false,
): WorkLogMarkerKind {
  return workLogMarker({
    live,
    failed: workEntryDisplayIndicatesToolFailure(entry),
    kind: toolGroupAction(entry),
  });
}

/** The live step reads darkest, finished steps muted, dead ends and branches lighter still. */
export function workLogLabelTone(marker: WorkLogMarkerKind): WorkLogLabelTone {
  if (marker === "live") return "active";
  return marker === "dead-end" ? "dim" : "done";
}

/** Dead ends hang off the main rail on a short branch, like the subagents they resemble. */
export function workLogMarkerLane(marker: WorkLogMarkerKind): "main" | "branch" {
  return marker === "dead-end" ? "branch" : "main";
}

export type WorkLogChip =
  | { readonly kind: "file"; readonly key: string; readonly path: string; readonly name: string }
  | {
      readonly kind: "web";
      readonly key: string;
      readonly label: string;
      readonly url: string | null;
    };

export interface WorkLogChipSet {
  readonly chips: ReadonlyArray<WorkLogChip>;
  readonly moreCount: number;
}

export const WORK_LOG_VISIBLE_CHIPS = 4;
export const EMPTY_WORK_LOG_CHIPS: WorkLogChipSet = { chips: [], moreCount: 0 };

/** A step's chips: the files it read, changed or found, and the pages it searched or fetched. */
export function workLogEntryChips(entry: WorkLogPresentationEntry): WorkLogChip[] {
  const action = toolGroupAction(entry);
  switch (action) {
    case "read":
      return fileChips([
        ...workEntryInputPaths(entry),
        ...(entry.viewedImagePath ? [entry.viewedImagePath] : []),
      ]);
    case "edit":
      return fileChips(workEntryChangedPaths(entry));
    case "code-search":
      return fileChips(workEntrySearchHits(entry));
    case "search":
      return webChips(entry);
    default:
      return [];
  }
}

// The timeline derives chips for every group on each structural update, so the count behind
// "+N more" stops here rather than walking every hit of a long run.
const MAX_COUNTED_CHIPS = 100;

/**
 * Chips for a run of steps, deduplicated in order. Past `limit` the rest collapse into
 * "+N more". Search output is parsed with a byte and line budget, so a huge grep result costs
 * the same as a small one.
 */
export function workLogChips(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
  limit = WORK_LOG_VISIBLE_CHIPS,
): WorkLogChipSet {
  const seen = new Set<string>();
  const chips: WorkLogChip[] = [];
  for (const entry of entries) {
    if (chips.length >= MAX_COUNTED_CHIPS) break;
    for (const chip of workLogEntryChips(entry)) {
      if (seen.has(chip.key)) continue;
      seen.add(chip.key);
      chips.push(chip);
    }
  }
  if (chips.length === 0) return EMPTY_WORK_LOG_CHIPS;
  return { chips: chips.slice(0, limit), moreCount: Math.max(0, chips.length - limit) };
}

export function workLogChipSetsEqual(a: WorkLogChipSet, b: WorkLogChipSet): boolean {
  return (
    a === b ||
    (a.moreCount === b.moreCount &&
      a.chips.length === b.chips.length &&
      a.chips.every((chip, index) => chip.key === b.chips[index]?.key))
  );
}

export function workLogHeaderLabel(input: {
  readonly state: "working" | "worked" | "stopped";
  readonly duration: string | null;
}): string {
  switch (input.state) {
    case "working":
      return `Working for ${input.duration ?? "0s"}`;
    case "worked":
      return input.duration ? `Worked for ${input.duration}` : "Worked";
    case "stopped":
      return input.duration ? `You stopped after ${input.duration}` : "You stopped this response";
  }
}

const MAX_SEARCH_OUTPUT_CHARS = 8_192;
const MAX_SEARCH_OUTPUT_LINES = 120;
const MAX_SEARCH_HITS = 50;
// A bare path with an extension: no spaces, quotes or globs. Grep's `path:line:text` is cut at the
// first `:` that precedes a line number before this is tested.
const FILE_PATH = /^(?:[A-Za-z]:)?[^\s:*?"<>|()[\]{}]+\.[A-Za-z0-9]{1,10}$/;

/** File paths listed in grep, glob or ripgrep output, one per line or as `path:line:text`. */
export function searchOutputFilePaths(text: string, maxPaths = MAX_SEARCH_HITS): string[] {
  const paths = new Set<string>();
  const lines = text.slice(0, MAX_SEARCH_OUTPUT_CHARS).split(/\r?\n/, MAX_SEARCH_OUTPUT_LINES);
  for (const rawLine of lines) {
    if (paths.size >= maxPaths) break;
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 400 || /^[a-z]+:\/\//i.test(line)) continue;
    const position = /^((?:[A-Za-z]:)?[^:]+):\d+(?::|$)/.exec(line);
    const candidate = (position?.[1] ?? line).replace(/^\.\//, "");
    if (FILE_PATH.test(candidate)) paths.add(candidate);
  }
  return [...paths];
}

export function fileChipName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function webChipLabel(url: string | null, title: string | undefined): string | null {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return trimmedTitle;
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function fileChips(paths: ReadonlyArray<string>): WorkLogChip[] {
  return paths.flatMap((path) => {
    const trimmed = path.trim();
    if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return [];
    return [
      { kind: "file" as const, key: `file:${trimmed}`, path: trimmed, name: fileChipName(trimmed) },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workEntryInputPaths(entry: WorkLogPresentationEntry): readonly string[] {
  if ((entry.changedFiles?.length ?? 0) > 0) return entry.changedFiles!;
  const item = entry.structuredPayload;
  if (item?.type === "dynamic_tool") {
    const paths = collectToolFilePaths({ input: item.input });
    if (paths.length > 0) return paths;
  }
  return collectToolFilePaths(asRecord(entry.toolData));
}

function workEntryChangedPaths(entry: WorkLogPresentationEntry): readonly string[] {
  const item = entry.structuredPayload;
  if (item?.type === "file_change") return [item.fileName, ...(entry.changedFiles ?? [])];
  return workEntryInputPaths(entry);
}

// Turn items keep their identity until they change, so a search's hits are parsed once.
const searchHitsByItem = new WeakMap<object, readonly string[]>();

function workEntrySearchHits(entry: WorkLogPresentationEntry): readonly string[] {
  const item = entry.structuredPayload;
  if (item === undefined) return entry.detail ? searchOutputFilePaths(entry.detail) : [];
  const cached = searchHitsByItem.get(item);
  if (cached) return cached;
  const hits = parseSearchHits(entry);
  searchHitsByItem.set(item, hits);
  return hits;
}

function parseSearchHits(entry: WorkLogPresentationEntry): string[] {
  const item = entry.structuredPayload;
  if (item?.type === "file_search" && item.results) {
    return [...new Set(item.results.slice(0, MAX_SEARCH_HITS).map((result) => result.fileName))];
  }
  if (item?.type === "dynamic_tool") {
    const listed = filenamesField(item.output);
    if (listed.length > 0) return listed;
    const text = outputText(item.output);
    if (text) return searchOutputFilePaths(text);
  }
  if (item?.type === "command_execution" && item.output) {
    return searchOutputFilePaths(item.output);
  }
  return entry.detail ? searchOutputFilePaths(entry.detail) : [];
}

/** Claude's Grep and Glob report their hits as `filenames`. */
function filenamesField(output: unknown): string[] {
  const filenames = asRecord(output)?.filenames;
  if (!Array.isArray(filenames)) return [];
  return filenames
    .slice(0, MAX_SEARCH_HITS)
    .filter((name): name is string => typeof name === "string");
}

function outputText(output: unknown, depth = 0): string | null {
  if (typeof output === "string") return output;
  if (depth > 2) return null;
  if (Array.isArray(output)) {
    const parts = output
      .slice(0, 20)
      .map((part) => outputText(part, depth + 1))
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  const record = asRecord(output);
  if (!record) return null;
  for (const key of ["text", "content", "output", "stdout", "result"] as const) {
    const text = outputText(record[key], depth + 1);
    if (text) return text;
  }
  return null;
}

function webChips(entry: WorkLogPresentationEntry): WorkLogChip[] {
  const item = entry.structuredPayload;
  const pages: Array<{ url: string | null; title: string | undefined }> = [];
  if (item?.type === "web_search" && item.results) {
    for (const result of item.results.slice(0, 20)) {
      pages.push({ url: result.url ?? null, title: result.title });
    }
  }
  if (pages.length === 0) {
    const input =
      item?.type === "dynamic_tool"
        ? asRecord(item.input)
        : asRecord(asRecord(entry.toolData)?.input);
    const url = typeof input?.url === "string" ? input.url : null;
    if (url) pages.push({ url, title: undefined });
  }
  return pages.flatMap(({ url, title }) => {
    const label = webChipLabel(url, title);
    if (label === null) return [];
    return [{ kind: "web" as const, key: `web:${url ?? label}`, label, url }];
  });
}
