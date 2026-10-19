import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isFreshFirstRunWorkspace, resolveFirstRunDecision } from "../../onboarding/firstRun.logic";
import { providerPickerPatch } from "../../onboarding/onboardingAgents.logic";
import { resolveProviderPickerPrompt, resolveProviderSetup } from "./providerSetup.logic";

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

describe("provider picker in a chat", () => {
  const empty = EnvironmentId.make("empty-server");
  const busy = EnvironmentId.make("busy-server");
  const allOff = [
    { enabled: false, status: "disabled" as const },
    { enabled: false, status: "disabled" as const },
  ];
  const codexOn = { ...off, [codexId]: { driver: codex, enabled: true } };
  const environments = {
    [empty]: { instances: off, providers: allOff },
    [busy]: { instances: codexOn, providers: [{ enabled: true, status: "ready" as const }] },
  };
  const prompt = (
    environmentId: EnvironmentId,
    options: { canManage?: boolean; dismissed?: ReadonlyArray<EnvironmentId> } = {},
  ) =>
    resolveProviderPickerPrompt({
      environmentId,
      ...environments[environmentId]!,
      blockedDrivers: [],
      canManage: options.canManage ?? true,
      dismissedEnvironmentIds: new Set(options.dismissed ?? []),
    });

  it("opens the picker when the server has no provider on", () => {
    expect(prompt(empty)).toBe("picker");
  });
  it("shows the notice instead once the picker was closed on that server", () => {
    expect(prompt(empty, { dismissed: [empty] })).toBe("inline");
  });
  it("hides both once a provider is on", () => {
    expect(prompt(busy)).toBe("hidden");
    expect(prompt(busy, { dismissed: [busy] })).toBe("hidden");
  });
  it("a connection that cannot change providers only gets the notice", () => {
    expect(prompt(empty, { canManage: false })).toBe("inline-read-only");
    expect(prompt(busy, { canManage: false })).toBe("hidden");
  });
  it("decides each environment on its own state and its own dismissal", () => {
    expect(prompt(empty, { dismissed: [busy] })).toBe("picker");
    expect(prompt(busy, { dismissed: [] })).toBe("hidden");
  });
  it("only counts providers the administrator allows", () => {
    expect(
      resolveProviderPickerPrompt({
        environmentId: busy,
        instances: codexOn,
        blockedDrivers: [codex],
        providers: [{ enabled: false, status: "disabled" }],
        canManage: true,
        dismissedEnvironmentIds: new Set(),
      }),
    ).toBe("picker");
  });
  it("trusts a running built-in default over settings without provider entries", () => {
    expect(
      resolveProviderPickerPrompt({
        environmentId: busy,
        instances: {},
        blockedDrivers: [],
        providers: [{ enabled: true, status: "ready" }],
        canManage: true,
        dismissedEnvironmentIds: new Set(),
      }),
    ).toBe("hidden");
  });
  it("waits for the server config", () => {
    expect(
      resolveProviderPickerPrompt({
        environmentId: empty,
        instances: null,
        blockedDrivers: [],
        providers: null,
        canManage: true,
        dismissedEnvironmentIds: new Set(),
      }),
    ).toBe("hidden");
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
