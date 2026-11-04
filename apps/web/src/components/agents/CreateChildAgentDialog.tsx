import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { create } from "zustand";

import { randomUUID } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { createdManualChild, manualChildAgentCommand } from "./createChildAgent.logic";

const useRequest = create<{ parent: ScopedThreadRef | null }>(() => ({ parent: null }));
export function openCreateChildAgentDialog(parent: ScopedThreadRef) {
  useRequest.setState({ parent });
}
const close = () => useRequest.setState({ parent: null });

export function CreateChildAgentDialogHost() {
  const parent = useRequest((state) => state.parent);
  return parent === null ? null : (
    <CreateChildAgentDialog key={scopedThreadKey(parent)} parent={parent} />
  );
}

function CreateChildAgentDialog({ parent }: { parent: ScopedThreadRef }) {
  const shell = useThreadShell(parent);
  const canOperate = useEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope);
  const navigate = useNavigate();
  const readProjection = useAtomQueryRunner(orchestrationEnvironment.v2.threadProjection, {
    refresh: true,
    reportFailure: false,
  });
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const operation = await settlePromise(async () => {
      if (!readEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope))
        throw new Error("This connection cannot create agents.");
      const before = await readProjection({
        environmentId: parent.environmentId,
        input: { threadId: parent.threadId },
      });
      if (before._tag === "Failure") throw squashAtomCommandFailure(before);
      const command = manualChildAgentCommand({
        parent: before.value,
        commandId: CommandId.make(randomUUID()),
        task,
        title,
        canOperate: readEnvironmentScope(parent.environmentId, AuthOrchestrationOperateScope),
      });
      const result = await dispatch({ environmentId: parent.environmentId, input: command });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const after = await readProjection({
        environmentId: parent.environmentId,
        input: { threadId: parent.threadId },
      });
      const child =
        after._tag === "Success" ? createdManualChild(before.value, after.value, command) : null;
      close();
      if (child !== null) {
        const target = scopeThreadRef(parent.environmentId, child);
        await navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: target.environmentId, threadId: target.threadId },
        });
      } else {
        toastManager.add({
          type: "success",
          title: "Child agent started",
          description: "Open it from this thread's agent tree.",
        });
      }
    });

    setBusy(false);

    if (operation._tag === "Failure") {
      const cause = squashAtomCommandFailure(operation);
      setError(cause instanceof Error ? cause.message : "Could not create the child agent.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New child agent</DialogTitle>
          <DialogDescription>
            Give an agent a task from {shell?.title ?? "this thread"}. It runs in its own worktree
            and reports back here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="viewcode-create-child-agent"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label className="grid gap-1.5 text-sm">
              Name, optional
              <Input
                value={title}
                disabled={busy}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="New agent"
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Task
              <Textarea
                autoFocus
                value={task}
                disabled={busy}
                onChange={(event) => setTask(event.target.value)}
                placeholder="What should this agent do?"
              />
            </label>
            {!canOperate || error ? (
              <p role="alert" className="text-sm text-destructive">
                {error ?? "This connection cannot create agents."}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="viewcode-create-child-agent"
            disabled={busy || !canOperate || !task.trim()}
          >
            {busy ? "Starting…" : "Start agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
