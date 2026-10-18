import type { ThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import {
  AuthOrchestrationOperateScope,
  ChatAttachmentId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  edit: vi.fn(),
  prepare: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
  queueAtom: null as unknown as Atom.Writable<ThreadQueueWorkflowState | null>,
  config: {
    providers: [{ instanceId: "codex", driver: "codex", enabled: true, disabledByAdmin: false }],
    environment: { capabilities: { attachmentUploads: true } },
  },
}));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useRef: <A>(current: A) => ({ current }),
  useState: <A>(value: A) => [value, vi.fn()],
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    parentDirectory = null;
    create() {}
    moveSync() {}
    async text() {
      return "{}";
    }
    write() {}
  },
  Paths: { document: "/documents" },
}));
vi.mock("../lib/composerImages", () => ({ removePersistedComposerAttachmentFile: vi.fn() }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    environmentId === "remote" && scope === AuthOrchestrationOperateScope && state.allowed,
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  state.queueAtom = Atom.make<ThreadQueueWorkflowState | null>(null).pipe(Atom.keepAlive);
  return {
    threadEnvironment: { editQueuedRun: state.edit },
    environmentThreadDetails: { queueWorkflowAtom: () => state.queueAtom },
  };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(state.config).pipe(Atom.keepAlive);
  return { serverEnvironment: { configValueAtom: () => config } };
});

import { appAtomRegistry } from "./atom-registry";
import {
  beginQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  queuedRunEditsAtom,
} from "./queued-run-edit";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import { activeComposerDraftKey, useQueuedRunEditComposer } from "./use-queued-run-edit-composer";

const thread = {
  environmentId: EnvironmentId.make("remote"),
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
};
const threadKey = "remote:thread";
const runId = RunId.make("queued-run");
const messageId = MessageId.make("queued-message");
const editKey = queuedEditDraftKey(threadKey, runId);
const attachment = (id: string) => ({
  type: "file" as const,
  id: ChatAttachmentId.make(id),
  name: `${id}.txt`,
  mimeType: "text/plain",
  sizeBytes: 5,
});
const workflow = (): ThreadQueueWorkflowState => ({
  activeRun: null,
  canReorder: true,
  canPromoteToSteer: false,
  isHeld: false,
  queuedRuns: [
    {
      messageId,
      text: "original queued message",
      attachments: [attachment("kept")],
      run: {
        id: runId,
        threadId: thread.id,
        ordinal: 2,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: DateTime.makeUnsafe("2026-10-18T00:00:00.000Z"),
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  ],
});
function composer() {
  return useQueuedRunEditComposer(thread, appAtomRegistry.get(state.queueAtom));
}
function startEdit() {
  beginQueuedRunEdit(threadKey, {
    runId,
    messageId,
    originalText: "original queued message",
    existingAttachments: [attachment("kept")],
  });
  setComposerDraftText(editKey, "edited queued message");
}
beforeEach(async () => {
  await waitForComposerDraftsLoaded();
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(queuedRunEditsAtom, {});
  appAtomRegistry.set(threadComposerErrorsAtom, {});
  appAtomRegistry.set(state.queueAtom, workflow());
  state.allowed = true;
  state.config.providers[0]!.enabled = true;
  state.config.providers[0]!.disabledByAdmin = false;
  state.edit.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 8 }));
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
  setComposerDraftText(threadKey, "untouched normal draft");
  startEdit();
});
afterEach(async () => {
  await flushComposerDrafts();
});

describe("retained mobile queued edit lifecycle", () => {
  it("saves a text-only edit without replacing server attachments and restores the normal draft", async () => {
    expect(activeComposerDraftKey(thread)).toBe(editKey);
    await composer().saveQueuedRunEdit();
    expect(state.edit).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: { threadId: "thread", runId, text: "edited queued message" },
    });
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(activeComposerDraftKey(thread)).toBe(threadKey);
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
  });

  it("edits the accepted run's provider even if another next-message provider is disabled", async () => {
    state.config.providers.push({
      instanceId: "claude",
      driver: "claudeAgent",
      enabled: false,
      disabledByAdmin: true,
    });
    updateComposerDraftSettings(threadKey, {
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
    });
    try {
      await composer().saveQueuedRunEdit();
      expect(state.edit).toHaveBeenCalledExactlyOnceWith({
        environmentId: "remote",
        input: { threadId: "thread", runId, text: "edited queued message" },
      });
      expect(getQueuedRunEdit(threadKey)).toBeNull();
      expect(getComposerDraftSnapshot(threadKey).modelSelection).toEqual({
        instanceId: "claude",
        model: "claude-sonnet",
      });
      expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
    } finally {
      state.config.providers.pop();
    }
  });

  it("cancels an edit without changing or resending the normal composer draft", () => {
    composer().cancelQueuedRunEdit();
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
    expect(state.edit).not.toHaveBeenCalled();
  });

  it("replaces attachments explicitly when an existing attachment is removed", async () => {
    composer().onRemoveQueuedEditAttachment("kept");
    await composer().saveQueuedRunEdit();
    expect(state.edit).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: {
        threadId: "thread",
        runId,
        text: "edited queued message",
        edit: { messageId, attachments: [] },
      },
    });
  });

  it("persists newly uploaded references before saving a full list including kept attachments", async () => {
    appendComposerDraftAttachments(editKey, [
      {
        id: "new-image",
        type: "image",
        previewUri: "data:image/png;base64,aA==",
        dataUrl: "data:image/png;base64,aA==",
        name: "new.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    ]);
    const uploaded = {
      type: "image" as const,
      id: ChatAttachmentId.make("uploaded-image"),
      name: "new.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    state.prepare.mockImplementationOnce(async ({ attachments, persistUploadedReferences }) => {
      const drafts = attachments.map((image) => ({
        ...image,
        uploadedAttachmentId: uploaded.id,
        uploadEnvironmentId: thread.environmentId,
      }));
      expect(await persistUploadedReferences?.(drafts)).toBe("persisted");
      expect(getComposerDraftSnapshot(editKey).attachments[0]?.uploadedAttachmentId).toBe(
        uploaded.id,
      );
      return {
        status: "ready",
        attachments: [uploaded],
        draftAttachments: drafts,
        pendingAttachmentIds: [uploaded.id],
      };
    });
    await composer().saveQueuedRunEdit();
    expect(state.edit).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: {
        threadId: "thread",
        runId,
        text: "edited queued message",
        edit: { messageId, attachments: [attachment("kept"), uploaded] },
      },
    });
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
  });

  it("holds one in-flight save and keeps its draft while the acceptance receipt is pending", async () => {
    const started = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AsyncResult.AsyncResult<{ sequence: number }, Error>>();
    state.edit.mockImplementationOnce(() => {
      started.resolve();
      return receipt.promise;
    });
    const editComposer = composer();
    const saving = editComposer.saveQueuedRunEdit();
    await started.promise;
    editComposer.cancelQueuedRunEdit();
    await editComposer.saveQueuedRunEdit();
    expect(state.edit).toHaveBeenCalledOnce();
    expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
    receipt.resolve(AsyncResult.success({ sequence: 8 }));
    await saving;
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
  });

  it("preserves the edit after a native delivery/cancellation race rejects its save", async () => {
    state.edit.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Run is no longer queued"))),
    );
    await composer().saveQueuedRunEdit();
    expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
    expect(getComposerDraftSnapshot(editKey).text).toBe("edited queued message");
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
  });

  it("keeps a remotely consumed edit separate and never recreates its message", async () => {
    appAtomRegistry.set(state.queueAtom, { ...workflow(), queuedRuns: [] });
    await composer().saveQueuedRunEdit();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.edit).not.toHaveBeenCalled();
    expect(getComposerDraftSnapshot(editKey).text).toBe("edited queued message");
    expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toContain(
      "already started or was removed",
    );
  });

  it.each(["permission", "provider", "admin", "consumed", "typing"] as const)(
    "rechecks %s after attachment preparation before saving",
    async (change) => {
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        if (change === "permission") state.allowed = false;
        if (change === "provider") state.config.providers[0]!.enabled = false;
        if (change === "admin") state.config.providers[0]!.disabledByAdmin = true;
        if (change === "consumed")
          appAtomRegistry.set(state.queueAtom, { ...workflow(), queuedRuns: [] });
        if (change === "typing") setComposerDraftText(editKey, "newer edit typed during upload");
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      await composer().saveQueuedRunEdit();
      expect(state.edit).not.toHaveBeenCalled();
      expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
      expect(getComposerDraftSnapshot(editKey).text).toBe(
        change === "typing" ? "newer edit typed during upload" : "edited queued message",
      );
      expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
    },
  );

  it("does not erase newer typing when the earlier edit receipt arrives", async () => {
    const started = Promise.withResolvers<void>();
    const receipt = Promise.withResolvers<AsyncResult.AsyncResult<{ sequence: number }, Error>>();
    state.edit.mockImplementationOnce(() => {
      started.resolve();
      return receipt.promise;
    });
    const save = composer().saveQueuedRunEdit();
    await started.promise;
    setComposerDraftText(editKey, "newer text while saving");
    receipt.resolve(AsyncResult.success({ sequence: 8 }));
    await save;
    expect(getQueuedRunEdit(threadKey)?.runId).toBe(runId);
    expect(getComposerDraftSnapshot(editKey).text).toBe("newer text while saving");
    expect(getComposerDraftSnapshot(threadKey).text).toBe("untouched normal draft");
  });
});
