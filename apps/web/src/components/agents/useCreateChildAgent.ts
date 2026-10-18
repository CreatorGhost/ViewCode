import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { openCreateChildAgentDialog } from "./CreateChildAgentDialog";

/** Resolves once the thread's shell reaches the client store (false on timeout). */
export function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 5_000): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(ref);
  if (appAtomRegistry.get(atom) !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = appAtomRegistry.subscribe(atom, (shell) => {
      if (shell === null) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    });
  });
}

/** Opens the native delegated-task prompt for this specific parent pane. */
export function createChildAgentHandler() {
  return (parent: EnvironmentThreadShell) =>
    openCreateChildAgentDialog(scopeThreadRef(parent.environmentId, parent.id));
}
