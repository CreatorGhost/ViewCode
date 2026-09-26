import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useMemo, useState } from "react";

import { refreshArchivedThreadsForEnvironment } from "../../lib/archivedThreadsState";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { importedThreadsForCleanup } from "./agentSessionImport.logic";

export interface RemoveImportedSessionsTarget {
  readonly title: string;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

const threadKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}\0${threadId}`;

/**
 * Archive a project's imported threads in one go. Threads nobody continued
 * are checked up front; continued ones are listed but left alone.
 */
export function RemoveImportedSessionsDialog({
  target,
  onClose,
}: {
  readonly target: RemoveImportedSessionsTarget | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target !== null ? (
        <RemoveImportedSessionsPopup
          key={target.projectRefs.map((ref) => `${ref.environmentId}\0${ref.projectId}`).join("\n")}
          target={target}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function RemoveImportedSessionsPopup({
  target,
  onClose,
}: {
  readonly target: RemoveImportedSessionsTarget;
  readonly onClose: () => void;
}) {
  const threads = useThreadShells();
  const archiveThread = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const entries = useMemo(
    () => importedThreadsForCleanup(threads, target.projectRefs),
    [threads, target.projectRefs],
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        entries.flatMap(({ thread, untouched }) =>
          untouched ? [threadKey(thread.environmentId, thread.id)] : [],
        ),
      ),
  );
  const [archiving, setArchiving] = useState(false);
  const selected = entries.filter(({ thread }) =>
    checked.has(threadKey(thread.environmentId, thread.id)),
  );

  const toggle = (key: string, value: boolean) => {
    const next = new Set(checked);
    if (value) next.add(key);
    else next.delete(key);
    setChecked(next);
  };

  const archiveSelected = async () => {
    if (archiving || selected.length === 0) return;
    setArchiving(true);
    let archived = 0;
    let failed = 0;
    const environments = new Set<EnvironmentId>();
    for (const { thread } of selected) {
      const result = await archiveThread({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Success") {
        archived += 1;
        environments.add(thread.environmentId);
      } else if (!isAtomCommandInterrupted(result)) {
        failed += 1;
      }
    }
    for (const environmentId of environments) refreshArchivedThreadsForEnvironment(environmentId);
    setArchiving(false);
    toastManager.add({
      type: failed > 0 ? "warning" : "success",
      title: `Archived ${archived} imported ${archived === 1 ? "thread" : "threads"}`,
      description:
        failed > 0
          ? `${failed} could not be archived.`
          : "Restore them any time from Settings → Archive.",
    });
    onClose();
  };

  return (
    <DialogPopup className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Remove imported sessions</DialogTitle>
        <DialogDescription>
          Archive threads imported into {target.title}. Threads you have not continued are checked.
          Archived chats can be restored from Settings → Archive.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This project has no imported threads.
          </p>
        ) : (
          <div className="space-y-0.5">
            {entries.map(({ thread, untouched }) => {
              const key = threadKey(thread.environmentId, thread.id);
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default"
                >
                  <Checkbox
                    checked={checked.has(key)}
                    disabled={archiving}
                    onCheckedChange={(value) => toggle(key, value === true)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
                  {untouched ? null : <Badge variant="info">Continued</Badge>}
                  <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {formatRelativeTimeLabel(thread.updatedAt)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={archiving || selected.length === 0}
          onClick={() => void archiveSelected()}
        >
          {archiving
            ? "Archiving…"
            : `Archive ${selected.length} ${selected.length === 1 ? "thread" : "threads"}`}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
