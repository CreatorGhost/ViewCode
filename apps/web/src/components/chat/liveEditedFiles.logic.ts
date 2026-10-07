import type { WorkLogEntry } from "../../session-logic";

/** Files shown individually before the strip collapses to a count. */
export const LIVE_EDITED_FILES_INLINE_LIMIT = 4;

/**
 * Distinct files the agent touched during `turnId`, in first-edit order, from
 * the tool rows already in client state. Empty when no turn is running.
 */
export function deriveLiveEditedFiles(
  entries: ReadonlyArray<Pick<WorkLogEntry, "turnId" | "changedFiles">>,
  turnId: string | null | undefined,
): string[] {
  if (!turnId) return [];
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.turnId !== turnId) continue;
    for (const file of entry.changedFiles ?? []) files.add(file);
  }
  return [...files];
}

/**
 * `filePath` relative to the workspace root, the form diff file paths take.
 * Tool rows may carry absolute paths; anything outside the root stays as is.
 */
export function toWorkspaceRelativePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  const path = filePath.replaceAll("\\", "/");
  const root = workspaceRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(/^(\.\/)+/, "");
}
