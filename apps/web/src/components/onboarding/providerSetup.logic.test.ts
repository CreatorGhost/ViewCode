import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isFreshFirstRunWorkspace, resolveFirstRunDecision } from "../../onboarding/firstRun.logic";
import { providerPickerPatch } from "../../onboarding/onboardingAgents.logic";
import { resolveProviderSetup } from "./providerSetup.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const off = {
  [codexId]: { driver: codex, enabled: false },
  [claudeId]: { driver: claude, enabled: false },
};

describe("provider setup", () => {
  it("shows the picker from fresh settings without waiting for provider probes", () => {
    expect(resolveProviderSetup({ instances: off, blockedDrivers: [], providers: null })).toEqual({
      pending: false,
      showPicker: true,
      refreshEnabledProviders: false,
    });
  });
  it("does not let stale enabled snapshots override an explicit off choice", () => {
    expect(
      resolveProviderSetup({
        instances: off,
        blockedDrivers: [],
        providers: [{ enabled: true, status: "ready" }],
      }).showPicker,
    ).toBe(true);
  });
  it("only permits provider refresh after an explicit Turn on choice", () => {
    const initial = structuredClone(off);
    const chosen = providerPickerPatch(new Set([codex]), initial).providerInstances!;
    expect(initial).toEqual(off);
    expect(
      resolveProviderSetup({ instances: chosen, blockedDrivers: [], providers: null }),
    ).toEqual({ pending: false, showPicker: false, refreshEnabledProviders: true });
    expect(chosen[codexId]?.enabled).toBe(true);
    expect(chosen[claudeId]?.enabled).toBe(false);
  });
  it("keeps an existing enabled account and does not rewrite its config", () => {
    const instances = {
      [codexId]: { driver: codex, enabled: true, config: { homePath: "/accounts/work" } },
    };
    expect(
      resolveProviderSetup({ instances, blockedDrivers: [], providers: null })
        .refreshEnabledProviders,
    ).toBe(true);
    expect(instances[codexId]?.config).toEqual({ homePath: "/accounts/work" });
  });
  it("a legacy nested disable or administrator restriction still wins", () => {
    expect(
      resolveProviderSetup({
        instances: { [codexId]: { driver: codex, enabled: true, config: { enabled: false } } },
        blockedDrivers: [],
        providers: null,
      }).showPicker,
    ).toBe(true);
    expect(
      resolveProviderSetup({
        instances: { [codexId]: { driver: codex, enabled: true } },
        blockedDrivers: [codex],
        providers: null,
      }).showPicker,
    ).toBe(true);
  });
  it("waits for unknown state and supports existing-server cached evidence", () => {
    expect(resolveProviderSetup({ instances: null, blockedDrivers: [], providers: null })).toEqual({
      pending: true,
      showPicker: false,
      refreshEnabledProviders: false,
    });
    expect(
      resolveProviderSetup({
        instances: null,
        blockedDrivers: [],
        providers: [{ enabled: true, status: "ready" }],
      }).refreshEnabledProviders,
    ).toBe(true);
    expect(
      resolveProviderSetup({
        instances: null,
        blockedDrivers: [],
        providers: [{ enabled: true, status: "ready", disabledByAdmin: true }],
      }).showPicker,
    ).toBe(true);
  });
});

describe("welcome creation provenance", () => {
  const project = { id: "bootstrap-project", environmentId: "local", workspaceRoot: "/workspace" };
  const workspace = {
    primaryEnvironmentId: "local",
    serverCwd: "/workspace",
    bootstrapProjectId: project.id,
    projects: [project],
    threads: [],
  };
  const evidence = {
    enabled: true,
    hydrated: true,
    completed: false,
    bootstrapped: true,
    authoritative: true,
    workspaceAuthoritative: true,
    workspaceProvenanceAuthoritative: true,
    catalogReady: true,
    serverConfigAvailable: true,
    projectCount: 1,
    threadCount: 0,
  };
  it("a newly auto-created project with no thread opens setup without persisting completion", () => {
    const workspaceFresh = isFreshFirstRunWorkspace({
      ...workspace,
      bootstrapProjectCreated: true,
    });
    expect(resolveFirstRunDecision({ ...evidence, workspaceFresh })).toEqual({
      decision: "wizard",
      persistCompletion: false,
    });
  });
  it("an existing unused cwd project remains existing user data", () => {
    const workspaceFresh = isFreshFirstRunWorkspace({
      ...workspace,
      bootstrapProjectCreated: false,
    });
    expect(resolveFirstRunDecision({ ...evidence, workspaceFresh })).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });
  it("does not guess provenance when an older server omits it", () => {
    expect(isFreshFirstRunWorkspace(workspace)).toBe(false);
  });
  it("a saved completed-onboarding choice still opens the app", () => {
    expect(resolveFirstRunDecision({ ...evidence, completed: true, workspaceFresh: true })).toEqual(
      { decision: "app", persistCompletion: false },
    );
  });
});
