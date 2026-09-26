import type { AgentSessionSummary, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { agentSessionImport, agentSessionList } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ClaudeAI, OpenAI } from "../Icons";
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
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  HIDDEN_REASON_LABELS,
  partitionImportableSessions,
  sessionKey,
} from "./agentSessionImport.logic";

export interface ImportSessionsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly title: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function plural(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Pick past Claude Code and Codex sessions to bring into one project. Nothing
 * is checked up front; sessions that look like agent plumbing (sub-agents,
 * agent-to-agent messages, fragments) sit behind "Show hidden".
 */
export function ImportSessionsDialog({
  target,
  onClose,
  onImported,
}: {
  readonly target: ImportSessionsTarget | null;
  readonly onClose: () => void;
  readonly onImported?: (importedCount: number) => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target !== null ? (
        <ImportSessionsPopup
          key={`${target.environmentId}\0${target.projectId}`}
          target={target}
          onClose={onClose}
          {...(onImported === undefined ? {} : { onImported })}
        />
      ) : null}
    </Dialog>
  );
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly sessions: ReadonlyArray<AgentSessionSummary> };

function ImportSessionsPopup({
  target,
  onClose,
  onImported,
}: {
  readonly target: ImportSessionsTarget;
  readonly onClose: () => void;
  readonly onImported?: (importedCount: number) => void;
}) {
  const listSessions = useAtomCommand(agentSessionList, { reportFailure: false });
  const importSessions = useAtomCommand(agentSessionImport, { reportFailure: false });
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  // Only the latest listing may land, and none after the dialog closes.
  const listRequestRef = useRef(0);

  const fetchSessions = useCallback(() => {
    const request = ++listRequestRef.current;
    void listSessions({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, expectedWorkspaceRoot: target.workspaceRoot },
    }).then((result) => {
      if (request !== listRequestRef.current || isAtomCommandInterrupted(result)) return;
      setList(
        result._tag === "Success"
          ? { status: "ready", sessions: result.value.sessions }
          : { status: "error", message: errorMessage(squashAtomCommandFailure(result)) },
      );
    });
  }, [listSessions, target.environmentId, target.projectId, target.workspaceRoot]);

  useEffect(() => {
    fetchSessions();
    return () => {
      listRequestRef.current += 1;
    };
  }, [fetchSessions]);

  const reload = () => {
    setList({ status: "loading" });
    fetchSessions();
  };

  const { visible, hidden } = useMemo(
    () => partitionImportableSessions(list.status === "ready" ? list.sessions : []),
    [list],
  );
  const shown = showHidden ? [...visible, ...hidden] : visible;
  const selected = (list.status === "ready" ? list.sessions : []).filter(
    (session) => !session.alreadyImported && checked.has(sessionKey(session)),
  );

  const toggle = (session: AgentSessionSummary, value: boolean) => {
    const next = new Set(checked);
    if (value) next.add(sessionKey(session));
    else next.delete(sessionKey(session));
    setChecked(next);
  };

  const runImport = async () => {
    if (importing || selected.length === 0) return;
    setImporting(true);
    setImportError("");
    const result = await importSessions({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        expectedWorkspaceRoot: target.workspaceRoot,
        sessions: selected.map(({ providerInstanceId, providerSessionId }) => ({
          providerInstanceId,
          providerSessionId,
        })),
      },
    });
    setImporting(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        setImportError(errorMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    const { importedCount, skippedCount } = result.value;
    onImported?.(importedCount);
    if (skippedCount > 0) {
      setImportError(
        `Imported ${plural(importedCount, "session")}. ${plural(skippedCount, "session")} could not be imported.`,
      );
      setChecked(new Set());
      reload();
      return;
    }
    toastManager.add({
      type: "success",
      title: `Imported ${plural(importedCount, "session")}`,
      description: target.title,
    });
    onClose();
  };

  return (
    <DialogPopup className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Import past sessions</DialogTitle>
        <DialogDescription>
          Choose Claude Code and Codex conversations from the last 30 days to continue in{" "}
          {target.title}. Imported sessions appear in the sidebar as threads.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {list.status === "loading" ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner size="md" />
            Reading past sessions…
          </div>
        ) : list.status === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">Could not read sessions. {list.message}</span>
            <Button variant="ghost" size="sm" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : list.sessions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No Claude Code or Codex sessions from the last 30 days in this folder.
          </p>
        ) : (
          <div className="space-y-0.5">
            {shown.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Every session here looks like agent plumbing. Show hidden to see them.
              </p>
            ) : null}
            {shown.map((session) => (
              <SessionRow
                key={sessionKey(session)}
                session={session}
                checked={session.alreadyImported || checked.has(sessionKey(session))}
                disabled={importing || session.alreadyImported}
                onCheckedChange={(value) => toggle(session, value)}
              />
            ))}
          </div>
        )}
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        {hidden.length > 0 ? (
          <Button
            variant="ghost-muted"
            size="sm"
            className="sm:mr-auto"
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? "Hide" : "Show"} hidden ({hidden.length})
          </Button>
        ) : null}
        {importError ? (
          <p role="alert" className="text-sm text-destructive sm:mr-auto">
            {importError}
          </p>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {importError ? "Close" : "Cancel"}
        </Button>
        <Button disabled={importing || selected.length === 0} onClick={() => void runImport()}>
          {importing
            ? "Importing…"
            : selected.length === 0
              ? "Import"
              : `Import ${plural(selected.length, "session")}`}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function SessionRow({
  session,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly session: AgentSessionSummary;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const ProviderIcon = session.provider === "claudeAgent" ? ClaudeAI : OpenAI;
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40 has-disabled:cursor-default has-disabled:opacity-70">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <ProviderIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-label={session.provider === "claudeAgent" ? "Claude Code" : "Codex"}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
      {session.alreadyImported ? (
        <Badge variant="secondary">Imported</Badge>
      ) : session.hiddenReason !== null ? (
        <Badge variant="outline">{HIDDEN_REASON_LABELS[session.hiddenReason]}</Badge>
      ) : null}
      <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {plural(session.userMessageCount, "message")} ·{" "}
        {formatRelativeTimeLabel(session.lastActivityAt)}
      </span>
    </label>
  );
}
