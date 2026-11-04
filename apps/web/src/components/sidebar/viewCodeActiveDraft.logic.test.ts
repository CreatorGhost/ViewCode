import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  composerDraftHasUserContent,
  DraftId,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  applyProviderInstanceSettings,
  deriveProviderEntriesByEnvironment,
} from "../../providerInstances";
import { resolveComposerProviderSelection } from "../ChatView.logic";
import { resolveViewCodeActiveDraft, viewCodeActiveDraftTitle } from "./viewCodeActiveDraft.logic";

const environmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("local-draft-thread");
const draftId = DraftId.make("local-draft");
const projectRef = scopeProjectRef(environmentId, projectId);
const remoteProjectRef = scopeProjectRef(remoteEnvironmentId, projectId);

function resetDrafts() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyActiveProvider: null,
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
  });
}

function activeRow(input?: Partial<Parameters<typeof resolveViewCodeActiveDraft>[0]>) {
  return resolveViewCodeActiveDraft({
    draftId,
    session: useComposerDraftStore.getState().getDraftSession(draftId),
    projectRefs: [projectRef],
    threads: [],
    ...input,
  });
}

function provider(instanceId: string, driver: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [{ slug: "selected-model", name: "Selected model", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}

beforeEach(() => {
  resetDrafts();
  useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, { threadId });
});
afterEach(resetDrafts);

describe("active local draft sidebar placement", () => {
  it("shows an empty draft before any prompt, native thread, or provider session exists", () => {
    const before = useComposerDraftStore.getState();
    const composer = before.getComposerDraft(draftId);
    expect(composerDraftHasUserContent(composer)).toBe(false);
    expect(viewCodeActiveDraftTitle(composer)).toBe("New thread");
    expect(activeRow()).toEqual({ draftId, session: before.getDraftSession(draftId) });
    // Resolving navigation must not promote or otherwise mutate the draft store.
    expect(useComposerDraftStore.getState()).toBe(before);
    expect(before.getDraftSession(draftId)?.promotedTo).toBeNull();
  });

  it("matches both environment and project, including a non-representative grouped member", () => {
    expect(activeRow({ projectRefs: [remoteProjectRef] })).toBeNull();
    expect(
      activeRow({ projectRefs: [scopeProjectRef(environmentId, ProjectId.make("other-project"))] }),
    ).toBeNull();
    expect(activeRow({ projectRefs: [remoteProjectRef, projectRef] })?.draftId).toBe(draftId);
  });

  it("gives way to the native shell during promotion before the local promotion flag arrives", () => {
    expect(activeRow({ threads: [{ environmentId, id: threadId }] })).toBeNull();
    // A colliding thread id on another environment is a different thread.
    expect(
      activeRow({ threads: [{ environmentId: remoteEnvironmentId, id: threadId }] }),
    ).not.toBeNull();
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
    expect(activeRow()).toBeNull();
  });

  it("removes the row on discard or route departure without discarding another invested draft", () => {
    const otherDraftId = DraftId.make("invested-draft");
    const otherRef = scopeProjectRef(environmentId, ProjectId.make("other-project"));
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(otherRef, otherDraftId, {
      threadId: ThreadId.make("other-thread"),
    });
    store.setPrompt(otherDraftId, "Keep this interrupted work");
    expect(activeRow({ draftId: null })).toBeNull();
    store.clearDraftThread(draftId);
    expect(activeRow()).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(otherDraftId)?.prompt).toBe(
      "Keep this interrupted work",
    );
  });

  it("keeps row subscription values stable while typing, and retains the invested title on reopen", () => {
    const store = useComposerDraftStore.getState();
    const selection = {
      instanceId: ProviderInstanceId.make("claude-work"),
      model: "selected-model",
    };
    store.setModelSelection(draftId, selection);
    const beforeSession = useComposerDraftStore.getState().getDraftSession(draftId);
    const beforeModel = useComposerDraftStore.getState().getComposerDraft(draftId)
      ?.modelSelectionByProvider[selection.instanceId];
    store.setPrompt(draftId, "Investigate this issue\nAdditional context");
    const after = useComposerDraftStore.getState();
    expect(after.getDraftSession(draftId)).toBe(beforeSession);
    expect(after.getComposerDraft(draftId)?.modelSelectionByProvider[selection.instanceId]).toBe(
      beforeModel,
    );
    expect(activeRow()?.session).toBe(beforeSession);
    expect(viewCodeActiveDraftTitle(after.getComposerDraft(draftId))).toBe(
      "Investigate this issue",
    );
  });
});

describe("active draft provider identity", () => {
  const codexId = ProviderInstanceId.make("codex");
  const claudeId = ProviderInstanceId.make("claude-work");
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [codexId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
    },
  };
  const catalogs = deriveProviderEntriesByEnvironment([
    [
      environmentId,
      [provider(codexId, "codex", "Local Codex"), provider(claudeId, "claudeAgent", "Work Claude")],
    ],
    [remoteEnvironmentId, [provider(codexId, "codex", "Remote Codex")]],
  ]);

  it("follows the draft's selected provider account rather than the first catalog entry", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(draftId, { instanceId: codexId, model: "selected-model" });
    store.setModelSelection(draftId, { instanceId: claudeId, model: "selected-model" });
    const composer = useComposerDraftStore.getState().getComposerDraft(draftId);
    const entries = applyProviderInstanceSettings(
      [...(catalogs.get(environmentId)?.values() ?? [])],
      settings,
      projectId,
    );
    const { selectedProviderEntry } = resolveComposerProviderSelection({
      entries,
      candidateInstanceIds: [composer?.activeProvider],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(selectedProviderEntry?.instanceId).toBe(claudeId);
    expect(selectedProviderEntry?.displayName).toBe("Work Claude");
    expect(selectedProviderEntry?.driverKind).toBe("claudeAgent");
    expect(composer?.modelSelectionByProvider[claudeId]?.model).toBe("selected-model");
    expect(catalogs.get(environmentId)?.get(codexId)?.displayName).toBe("Local Codex");
    expect(catalogs.get(remoteEnvironmentId)?.get(codexId)?.displayName).toBe("Remote Codex");
  });

  it("shows no provider when every choice is disabled and does not enable one for the row", () => {
    const disabledSettings = {
      ...settings,
      providerInstances: Object.fromEntries(
        Object.entries(settings.providerInstances).map(([id, config]) => [
          id,
          { ...config, enabled: false },
        ]),
      ),
    };
    const before = useComposerDraftStore.getState();
    const entries = applyProviderInstanceSettings(
      [...(catalogs.get(environmentId)?.values() ?? [])],
      disabledSettings,
      projectId,
    );
    const { selectedProviderEntry } = resolveComposerProviderSelection({
      entries,
      candidateInstanceIds: [codexId],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(selectedProviderEntry).toBeUndefined();
    expect(useComposerDraftStore.getState()).toBe(before);
    expect(activeRow()).not.toBeNull();
    expect(Object.values(disabledSettings.providerInstances).every((entry) => !entry.enabled)).toBe(
      true,
    );
  });
});
