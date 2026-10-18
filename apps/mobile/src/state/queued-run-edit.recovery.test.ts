import {
  ChatAttachmentId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const disk = vi.hoisted(() => ({ document: "", readBarrier: Promise.resolve() }));
const worker = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  prepare: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
  readAtom: <A>(_atom: import("effect/reactivity").Atom.Atom<A>): A => {
    throw new Error("App registry not loaded");
  },
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => worker.effects.push(effect),
  useRef: <A>(current: A) => ({ current }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: <A>(atom: import("effect/reactivity").Atom.Atom<A>) => worker.readAtom(atom),
}));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: worker.prepare }));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([["remote:server", { environment: { capabilities: { attachmentUploads: true } } }]]),
}));
vi.mock("./use-thread-outbox", () => ({ useThreadOutboxMessages: () => [] }));
vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [{ environmentId: "remote:server", connectionState: "connected" }],
  }),
}));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = true;
    parentDirectory = null;
    create() {}
    moveSync() {}
    async text() {
      await disk.readBarrier;
      return disk.document;
    }
    write(value: string) {
      disk.document = value;
    }
  },
  Paths: { document: "/documents" },
}));
vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: vi.fn(),
  toUploadChatImageAttachments: () => [],
  isFileBackedComposerAttachment: () => false,
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));

async function loadApp() {
  const [edits, drafts, atoms, errors] = await Promise.all([
    import("./queued-run-edit"),
    import("./use-composer-drafts"),
    import("./atom-registry"),
    import("./thread-composer-error"),
  ]);
  worker.readAtom = (atom) => atoms.appAtomRegistry.get(atom);
  return { edits, drafts, ...atoms, ...errors };
}
type App = Awaited<ReturnType<typeof loadApp>>;
let current: App | null = null;
const key = "remote:server:8b3c3f9a-0f9c-4b82-a6f7-f0fbca3dc1c1";
const image = (id: string) => ({
  type: "image" as const,
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 1,
});
const context = (id: string): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${id}`),
      label: `${id}.png`,
      attachmentId: id,
      name: `${id}.png`,
      mimeType: "image/png",
      sizeBytes: 1,
    },
  ],
});
const originalContext = context("kept");
const source = {
  runId: RunId.make("run:thread:8b3c3f9a-0f9c-4b82-a6f7-f0fbca3dc1c1:ordinal:2"),
  messageId: MessageId.make("message"),
  originalText: `original ${formatComposerContextReference(originalContext.records[0]!)}`,
  existingAttachments: [image("kept"), image("removed")],
  context: originalContext,
};
const editKey = () => current!.edits.queuedEditDraftKey(key, source.runId);

async function restart() {
  await current!.drafts.flushComposerDrafts();
  current!.appAtomRegistry.dispose();
  vi.resetModules();
  current = await loadApp();
  await current.drafts.waitForComposerDraftsLoaded();
  return current;
}

beforeEach(async () => {
  worker.effects = [];
  worker.prepare.mockReset();
  vi.resetModules();
  disk.document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  disk.readBarrier = Promise.resolve();
  current = await loadApp();
  await current.drafts.waitForComposerDraftsLoaded();
  current.drafts.setComposerDraftText(key, "normal unsent draft");
  await current.edits.beginQueuedRunEdit(key, source);
});
afterEach(async () => {
  if (current) {
    await current.drafts.flushComposerDrafts();
    current.appAtomRegistry.dispose();
  }
});

describe("queued edit process recovery", () => {
  it("routes a reloaded native-run edit upload and clipboard context to its owning environment", async () => {
    const localImage = {
      id: "new-image",
      type: "image" as const,
      name: "new.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUri: "data:image/png;base64,aA==",
      dataUrl: "data:image/png;base64,aA==",
    };
    current!.drafts.appendComposerDraftAttachments(editKey(), [localImage]);
    const imageContext = context(localImage.id);
    current!.drafts.setComposerDraftText(
      editKey(),
      `edit ${formatComposerContextReference(imageContext.records[0]!)}`,
    );
    current!.drafts.setComposerDraftContext(editKey(), imageContext);
    const app = await restart();
    const environmentId = EnvironmentId.make("remote:server");
    expect(app.drafts.findLocalComposerClipboardAttachment(environmentId, localImage.id)).toEqual(
      localImage,
    );
    expect(
      app.drafts.findLocalComposerClipboardAttachment(EnvironmentId.make("other"), localImage.id),
    ).toBeUndefined();
    const persisted = Promise.withResolvers<void>();
    worker.prepare.mockImplementation(async (input) => {
      expect(input.environmentId).toBe(environmentId);
      expect(input.attachments).toEqual([localImage]);
      const status = await input.persistUploadedReferences?.([
        { ...localImage, uploadEnvironmentId: environmentId, uploadedAttachmentId: "server-image" },
      ]);
      expect(status).toBe("persisted");
      persisted.resolve();
      return {
        status: "ready",
        attachments: [image("server-image")],
        draftAttachments: input.attachments,
        pendingAttachmentIds: [],
      };
    });
    const { useComposerAttachmentUploadWorker } = await import("./composer-attachment-uploads");
    useComposerAttachmentUploadWorker();
    const dispose = worker.effects[0]!();
    try {
      worker.effects[1]!();
      await persisted.promise;
      expect(worker.prepare).toHaveBeenCalledOnce();
      const draft = app.drafts.getComposerDraftSnapshot(editKey());
      expect(draft.attachments).toEqual([
        { ...localImage, uploadEnvironmentId: environmentId, uploadedAttachmentId: "server-image" },
      ]);
      const payload = app.edits.resolveQueuedEditPayload({
        edit: app.edits.getQueuedRunEdit(key)!,
        draftContext: draft.context,
        draftAttachments: draft.attachments,
        uploaded: [image("server-image")],
      });
      expect(payload.context?.records).toEqual([
        expect.objectContaining({ attachmentId: "server-image" }),
      ]);
      expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
    } finally {
      if (dispose) dispose();
    }
  });

  it("reloads real persisted text, inline attachments, context, and kept attachment choices", async () => {
    const app = current!;
    const addedContext = context("new-image");
    const text = `unsaved edit ${formatComposerContextReference(addedContext.records[0]!)}`;
    app.drafts.setComposerDraftText(editKey(), text);
    app.drafts.appendComposerDraftAttachments(editKey(), [
      {
        id: "new-image",
        type: "image",
        name: "new.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUri: "data:image/png;base64,aA==",
        dataUrl: "data:image/png;base64,aA==",
      },
    ]);
    app.drafts.setComposerDraftContext(editKey(), addedContext);
    app.edits.removeQueuedRunEditAttachment(key, "removed");
    const before = app.drafts.getComposerDraftSnapshot(editKey());
    const reloaded = await restart();
    expect(reloaded.edits.getQueuedRunEdit(key)).toMatchObject({
      runId: source.runId,
      originalText: source.originalText,
      originalAttachments: source.existingAttachments,
      existingAttachments: [image("kept")],
      context: originalContext,
    });
    expect(reloaded.drafts.getComposerDraftSnapshot(editKey())).toEqual(before);
    await reloaded.edits.beginQueuedRunEdit(key, source);
    expect(reloaded.drafts.getComposerDraftSnapshot(editKey()).text).toBe(text);
    expect(reloaded.drafts.getComposerDraftSnapshot(editKey()).context).toEqual(addedContext);
    expect(reloaded.drafts.getComposerDraftSnapshot(editKey()).attachments).toEqual(
      before.attachments,
    );
    expect(reloaded.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
  });

  it("distinguishes an intentionally emptied edit from a new key after restart", async () => {
    current!.drafts.setComposerDraftText(editKey(), "");
    current!.edits.removeQueuedRunEditAttachment(key, "kept");
    current!.edits.removeQueuedRunEditAttachment(key, "removed");
    const app = await restart();
    expect(app.edits.getQueuedRunEdit(key)?.existingAttachments).toEqual([]);
    await app.edits.beginQueuedRunEdit(key, source);
    expect(app.drafts.getComposerDraftSnapshot(editKey()).text).toBe("");
    expect(app.edits.getQueuedRunEdit(key)?.existingAttachments).toEqual([]);
    expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
  });

  it("waits for disk hydration before deciding whether the edit key is new", async () => {
    current!.drafts.setComposerDraftText(editKey(), "saved before restart");
    await current!.drafts.flushComposerDrafts();
    current!.appAtomRegistry.dispose();
    vi.resetModules();
    const read = Promise.withResolvers<void>();
    disk.readBarrier = read.promise;
    const app = await loadApp();
    current = app;
    const opening = app.edits.beginQueuedRunEdit(key, source);
    expect(app.edits.getQueuedRunEdit(key)).toBeNull();
    read.resolve();
    await opening;
    expect(app.drafts.getComposerDraftSnapshot(editKey()).text).toBe("saved before restart");
    expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
  });

  it.each(["text", "attachments", "context"] as const)(
    "warns before a recovered edit can replace remotely changed %s",
    async (changed) => {
      current!.drafts.setComposerDraftText(editKey(), "my unsaved changes");
      const app = await restart();
      const latest = {
        ...source,
        ...(changed === "text" ? { originalText: "edited on desktop" } : {}),
        ...(changed === "attachments" ? { existingAttachments: [image("remote-added")] } : {}),
        ...(changed === "context" ? { context: context("remote-added") } : {}),
      };
      await app.edits.beginQueuedRunEdit(key, latest);
      expect(app.appAtomRegistry.get(app.threadComposerErrorsAtom)[key]?.message).toContain(
        "changed since this edit began",
      );
      expect(app.drafts.getComposerDraftSnapshot(editKey()).text).toBe("my unsaved changes");
      expect(app.edits.getQueuedRunEdit(key)?.originalText).toBe(source.originalText);
      expect(app.edits.getQueuedRunEdit(key)?.originalAttachments).toEqual(
        source.existingAttachments,
      );
      expect(app.edits.getQueuedRunEdit(key)?.context).toEqual(originalContext);
      expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
    },
  );

  it("preserves inactive edits when switching rows and restores only the last active role", async () => {
    current!.drafts.setComposerDraftText(editKey(), "first row unsaved");
    const second = {
      ...source,
      runId: RunId.make("second-run"),
      messageId: MessageId.make("second-message"),
      originalText: "second original",
    };
    await current!.edits.beginQueuedRunEdit(key, second);
    const secondKey = current!.edits.queuedEditDraftKey(key, second.runId);
    current!.drafts.setComposerDraftText(secondKey, "second row unsaved");
    const app = await restart();
    expect(app.edits.getQueuedRunEdit(key)?.runId).toBe(second.runId);
    app.edits.endQueuedRunEdit(key);
    expect(app.edits.getQueuedRunEdit(key)).toBeNull();
    expect(app.drafts.getComposerDraftSnapshot(editKey()).text).toBe("first row unsaved");
    await app.edits.beginQueuedRunEdit(key, source);
    expect(app.drafts.getComposerDraftSnapshot(editKey()).text).toBe("first row unsaved");
    expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
  });

  it("recovers an older nonempty edit key without metadata instead of reseeding it", async () => {
    current!.drafts.setComposerDraftText(editKey(), "unfinished edit from the earlier version");
    await current!.drafts.flushComposerDrafts();
    current!.appAtomRegistry.dispose();
    const persisted = JSON.parse(disk.document) as {
      drafts: Record<string, { queuedRunEdit?: unknown }>;
    };
    delete persisted.drafts[editKey()]!.queuedRunEdit;
    disk.document = JSON.stringify(persisted);
    vi.resetModules();
    current = await loadApp();
    await current.drafts.waitForComposerDraftsLoaded();
    expect(current.edits.getQueuedRunEdit(key)).toBeNull();
    await current.edits.beginQueuedRunEdit(key, source);
    expect(current.drafts.getComposerDraftSnapshot(editKey()).text).toBe(
      "unfinished edit from the earlier version",
    );
    expect(current.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
    expect(current.appAtomRegistry.get(current.threadComposerErrorsAtom)[key]?.message).toContain(
      "Recovered your unsaved queued edit",
    );
  });

  it("refuses mismatched message identity without overwriting the persisted edit", async () => {
    current!.drafts.setComposerDraftText(editKey(), "my original message edit");
    const app = await restart();
    const before = app.drafts.getComposerDraftSnapshot(editKey());
    await app.edits.beginQueuedRunEdit(key, {
      ...source,
      messageId: MessageId.make("different-message"),
    });
    expect(app.drafts.getComposerDraftSnapshot(editKey())).toEqual(before);
    expect(app.edits.getQueuedRunEdit(key)?.messageId).toBe(source.messageId);
    expect(app.appAtomRegistry.get(app.threadComposerErrorsAtom)[key]?.message).toContain(
      "different queued message",
    );
    expect(app.drafts.getComposerDraftSnapshot(key).text).toBe("normal unsent draft");
  });
});
