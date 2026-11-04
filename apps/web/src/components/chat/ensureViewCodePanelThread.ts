import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CreateThreadInput } from "@t3tools/client-runtime/operations";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_MODEL,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../../providerInstances";

type PanelThreadShell = {
  readonly projectId: CreateThreadInput["projectId"];
  readonly deletedAt: string | null;
};
export interface EnsureViewCodePanelThreadInput {
  readonly draftId?: DraftId | null | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly modelSelection?: ModelSelection | null | undefined;
  /** Shared with first send, so materialization and message launch cannot race. */
  readonly submissionLock: { current: boolean };
}

const pending = new Map<string, Promise<ScopedThreadRef | null>>();

/** Read synchronously from every goal/debug entrypoint, including stale click handlers. */
export function isViewCodePanelThreadPreparing(threadRef: ScopedThreadRef): boolean {
  return pending.has(scopedThreadKey(threadRef));
}

export function makeEnsureViewCodePanelThread(deps: {
  readonly create: (input: {
    environmentId: EnvironmentId;
    input: CreateThreadInput;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly readThread: (ref: ScopedThreadRef) => PanelThreadShell | null;
  readonly waitForThread: (ref: ScopedThreadRef) => Promise<boolean>;
  readonly canOperate: (environmentId: EnvironmentId) => boolean;
  readonly now: () => string;
}) {
  return (input: EnsureViewCodePanelThreadInput): Promise<ScopedThreadRef | null> => {
    const { threadRef, submissionLock } = input;
    const key = scopedThreadKey(threadRef);
    const existing = deps.readThread(threadRef);
    if (existing !== null) return Promise.resolve(existing.deletedAt === null ? threadRef : null);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (submissionLock.current || !deps.canOperate(threadRef.environmentId))
      return Promise.resolve(null);
    const store = useComposerDraftStore.getState();
    const draftId = input.draftId ?? store.getDraftIdByRef(threadRef);
    const draft = draftId ? store.getDraftSession(draftId) : null;
    if (
      !draftId ||
      !draft ||
      draft.environmentId !== threadRef.environmentId ||
      draft.threadId !== threadRef.threadId
    )
      return Promise.resolve(null);
    const composer = store.getComposerDraft(draftId);
    const storedSelection = composer?.activeProvider
      ? composer.modelSelectionByProvider[composer.activeProvider]
      : null;
    const selection = [storedSelection, input.modelSelection].find(
      (candidate) =>
        candidate != null &&
        candidate.instanceId !== NO_PROVIDER_MODEL_SELECTION.instanceId &&
        candidate.model.trim().length > 0,
    );
    // This is durable metadata only. It neither selects a composer provider nor
    // enables one; all actual sends still cross the native provider-policy gate.
    const modelSelection =
      selection &&
      selection.instanceId !== NO_PROVIDER_MODEL_SELECTION.instanceId &&
      selection.model.trim()
        ? selection
        : { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL };
    submissionLock.current = true;
    const work = (async () => {
      const created = await deps.create({
        environmentId: threadRef.environmentId,
        input: {
          commandId: CommandId.make(`viewcode-panel:${key}`),
          threadId: threadRef.threadId,
          projectId: draft.projectId,
          title: "New thread",
          modelSelection,
          runtimeMode: composer?.runtimeMode ?? draft.runtimeMode,
          interactionMode: composer?.interactionMode ?? draft.interactionMode,
          branch: draft.branch,
          worktreePath: draft.worktreePath,
          ...(draft.goal
            ? { viewcodeGoal: { objective: draft.goal, pausedAt: null, updatedAt: deps.now() } }
            : {}),
          ...(draft.debugMode === undefined ? {} : { debugMode: draft.debugMode }),
        },
      });
      if (created._tag === "Failure") {
        if (isAtomCommandInterrupted(created)) return null;
        throw squashAtomCommandFailure(created);
      }
      if (!(await deps.waitForThread(threadRef)))
        throw new Error(
          "The thread was saved but is not available yet. Try again after it appears in the sidebar.",
        );
      const saved = deps.readThread(threadRef);
      if (!saved || saved.deletedAt !== null || saved.projectId !== draft.projectId) return null;
      // Keep the draft route and session: they own prompt/uploads and pending
      // worktree intent until the first real message completes native promotion.
      useComposerDraftStore.getState().markDraftThreadPromoting(draftId, threadRef);
      return threadRef;
    })().finally(() => {
      pending.delete(key);
      submissionLock.current = false;
    });
    pending.set(key, work);
    return work;
  };
}
