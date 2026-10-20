import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * RockBot: chats over every project in an environment. Each is an ordinary thread
 * with `kind: "orchestrator"`, listed under RockBot rather than with the user's
 * threads.
 */
export function isRockBot(thread: { readonly kind?: string | null | undefined }): boolean {
  return thread.kind === "orchestrator";
}

/** One environment's live RockBot chats, newest first: RockBot's history. */
export function rockBotChatsIn<
  T extends {
    readonly environmentId: string;
    readonly kind?: string | null | undefined;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  },
>(threads: ReadonlyArray<T>, environmentId: string): T[] {
  return threads
    .filter(
      (thread) =>
        thread.kind === "orchestrator" &&
        thread.environmentId === environmentId &&
        thread.archivedAt === null,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Whether a project folder holds RockBot chats and nothing the user started there.
 * RockBot keeps its chats in the scratch folder only so its agent never runs in a
 * repository, so such a folder is RockBot's, and lists hide it rather than show an
 * empty "No project". Archived threads and side chats do not count.
 */
export function holdsOnlyRockBot<T extends RockBotFolderThread>(
  memberProjectKeys: ReadonlySet<string>,
  threads: ReadonlyArray<T>,
  kindOf: (thread: T) => string | null | undefined,
): boolean {
  let rockBot = false;
  for (const thread of threads) {
    if (!memberProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) continue;
    const kind = kindOf(thread);
    if (kind === "orchestrator") rockBot = true;
    else if (kind == null && thread.archivedAt === null) return false;
  }
  return rockBot;
}

interface RockBotFolderThread {
  readonly environmentId: string;
  readonly projectId: string;
  readonly archivedAt: string | null;
}

export function createRockBotEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    /** Resolves to the latest RockBot chat (creating one on first use), or a new chat. */
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rockbot:open",
      tag: WS_METHODS.rockbotOpen,
      scheduler,
      // Two clicks before the first create returns still make one thread.
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}
