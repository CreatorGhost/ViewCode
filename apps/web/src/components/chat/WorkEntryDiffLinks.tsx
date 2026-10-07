import type { TurnId } from "@t3tools/contracts";
import { FileDiffIcon } from "lucide-react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { toWorkspaceRelativePath } from "./liveEditedFiles.logic";
import { Button } from "../ui/button";

/**
 * Under an expanded file-change row: one button per edited file that opens
 * that file's diff for the turn in the diff panel. The work log carries the
 * paths but not the patch; the turn checkpoint has the diff, so it only exists
 * once the turn has settled.
 */
export function WorkEntryDiffLinks(props: {
  turnId: TurnId;
  changedFiles: ReadonlyArray<string>;
  workspaceRoot: string | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const files = [...new Set(props.changedFiles)];
  if (files.length === 0) return null;
  return (
    <div className="mt-1 ms-6 flex flex-wrap gap-1" data-scroll-anchor-ignore>
      {files.map((filePath) => {
        const label = formatWorkspaceRelativePath(filePath, props.workspaceRoot);
        return (
          <Button
            key={filePath}
            type="button"
            size="micro"
            variant="ghost-muted"
            aria-label={`Open diff for ${label}`}
            onClick={() =>
              props.onOpenTurnDiff(
                props.turnId,
                toWorkspaceRelativePath(filePath, props.workspaceRoot),
              )
            }
          >
            <FileDiffIcon />
            <span className="max-w-64 truncate font-mono">{label}</span>
          </Button>
        );
      })}
    </div>
  );
}
