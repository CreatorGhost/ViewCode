import { FileDiffIcon } from "lucide-react";
import { useMemo } from "react";

import type { WorkLogEntry } from "../../session-logic";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  deriveLiveEditedFiles,
  LIVE_EDITED_FILES_INLINE_LIMIT,
  toWorkspaceRelativePath,
} from "./liveEditedFiles.logic";

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * "Editing 3 files" strip above the composer while a turn runs. A running turn
 * has no turn diff until its checkpoint lands, so each file opens the working
 * tree diff at that file (a workspace-relative path, as the diff names it);
 * past a few files it collapses to a count that opens the whole working tree.
 */
export function useLiveEditedFilesBanner(input: {
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly runningTurnId: string | null;
  readonly workspaceRoot: string | undefined;
  readonly onOpenWorkingTreeDiff: (filePath?: string) => void;
}): ComposerBannerStackItem | null {
  const { entries, runningTurnId, workspaceRoot, onOpenWorkingTreeDiff } = input;
  const files = useMemo(
    () => deriveLiveEditedFiles(entries, runningTurnId),
    [entries, runningTurnId],
  );

  return useMemo(() => {
    if (runningTurnId === null || files.length === 0) return null;
    const turnId = runningTurnId;
    const collapsed = files.length > LIVE_EDITED_FILES_INLINE_LIMIT;
    return {
      id: `live-edited-files:${turnId}`,
      variant: "info",
      priority: "activity",
      compact: true,
      icon: <FileDiffIcon className="size-4" />,
      title: `Editing ${files.length} ${files.length === 1 ? "file" : "files"}`,
      actions: collapsed ? (
        <Button size="xs" variant="ghost" onClick={() => onOpenWorkingTreeDiff()}>
          View changes
        </Button>
      ) : (
        <div className="flex min-w-0 flex-wrap justify-end gap-1">
          {files.map((file) => (
            <Button
              key={file}
              size="xs"
              variant="ghost"
              title={file}
              className="max-w-40"
              onClick={() => onOpenWorkingTreeDiff(toWorkspaceRelativePath(file, workspaceRoot))}
            >
              <span className="truncate">{baseName(file)}</span>
            </Button>
          ))}
        </div>
      ),
    };
  }, [files, onOpenWorkingTreeDiff, runningTurnId, workspaceRoot]);
}
