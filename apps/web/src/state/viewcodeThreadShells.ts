import type { EnvironmentThreadShell as NativeThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadShell } from "@t3tools/client-runtime/viewcodeThread";
import {
  readThreadShell as readNativeThreadShell,
  useThreadShell as useNativeThreadShell,
  useThreadShells as useNativeThreadShells,
  useThreadShellsForProjectRefs as useNativeProjectThreadShells,
} from "./entities";
import type { ScopedThreadRef, ScopedProjectRef } from "@t3tools/contracts";

type LegacyShell = ReturnType<typeof scopeThreadShell>;
export type ViewCodeSidebarThread = NativeThreadShell &
  Pick<
    LegacyShell,
    "session" | "latestTurn" | "kind" | "parentThreadId" | "debugMode" | "backgroundLiveness"
  >;

function present(thread: NativeThreadShell): ViewCodeSidebarThread {
  const { session, latestTurn, kind, parentThreadId, debugMode, backgroundLiveness } =
    scopeThreadShell(thread.environmentId, thread.source);
  return {
    ...thread,
    session,
    latestTurn,
    ...(kind === undefined ? {} : { kind }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(debugMode === undefined ? {} : { debugMode }),
    ...(backgroundLiveness === undefined ? {} : { backgroundLiveness }),
  };
}

export function useViewCodeThreadShells(enabled = true): ReadonlyArray<ViewCodeSidebarThread> {
  const threads = useNativeThreadShells(enabled);
  return (() => threads.map(present))();
}

export function readViewCodeThreadShell(ref: ScopedThreadRef): ViewCodeSidebarThread | null {
  const thread = readNativeThreadShell(ref);
  return thread === null ? null : present(thread);
}

export function useViewCodeThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<ViewCodeSidebarThread> {
  const threads = useNativeProjectThreadShells(refs);
  return (() => threads.map(present))();
}

export function useViewCodeThreadShell(ref: ScopedThreadRef | null): ViewCodeSidebarThread | null {
  const thread = useNativeThreadShell(ref);
  return (() => (thread === null ? null : present(thread)))();
}
