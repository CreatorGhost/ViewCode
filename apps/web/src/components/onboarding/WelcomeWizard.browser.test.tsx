import { RegistryContext } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type WizardServerConfig = Pick<ServerConfig, "settings" | "adminBlockedProviderDrivers">;

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  detect: vi.fn(),
  update:
    vi.fn<
      (input: {
        environmentId: EnvironmentId;
        input: { patch: ServerSettingsPatch };
      }) => Promise<{ _tag: "Success"; value: undefined }>
    >(),
  providerAction: vi.fn(),
  config: null as WizardServerConfig | null,
  configAtom: null as unknown,
  providersAtom: null as unknown,
  providers: [] as readonly ServerProvider[],
  toast: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/agentSessions", () => ({
  agentSessionImport: "import",
  agentSessionList: "list",
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : command === "refresh"
          ? mocks.refresh
          : command === "detect"
            ? mocks.detect
            : command === "update"
              ? mocks.update
              : mocks.providerAction,
}));
vi.mock("../../onboarding/firstRun", () => ({ completeOnboarding: mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => mocks.providersAtom,
    configValueAtom: () => mocks.configAtom,
    refreshProviders: "refresh",
    detectProviders: "detect",
    updateSettings: "update",
  },
}));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";
import { appAtomRegistry } from "../../rpc/atomRegistry";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockResolvedValue(undefined);
  // Import tests represent an already configured environment. A new install
  // with all providers off is exercised separately below.
  mocks.config = {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    },
    adminBlockedProviderDrivers: [],
  };
  mocks.providers = [];
  mocks.configAtom = Atom.make(mocks.config).pipe(Atom.keepAlive);
  mocks.providersAtom = Atom.make(mocks.providers).pipe(Atom.keepAlive);
  mocks.refresh.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.detect.mockResolvedValue({ _tag: "Success", value: { providers: [] } });
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.providerAction.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderWizard(onDone: Parameters<typeof WelcomeWizard>[0]["onDone"]) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <WelcomeWizard localAvailable onDone={onDone} />
      </RegistryContext.Provider>,
    ),
  );
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it("adds a chosen project, offers its past sessions and lands in it", async () => {
  const onDone = vi.fn();
  await renderWizard(onDone);
  await click("Continue");
  await click("Continue");
  await click("Select all");
  await click("Add 1 project");
  expect(document.body.textContent).toContain("Bring in past conversations?");
  expect(document.body.textContent).toContain("Choose sessions…");
  expect(onDone).not.toHaveBeenCalled();
  await click("Done");
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
  expect(mocks.importThreads).not.toHaveBeenCalled();
});

it("starts fresh without adding a project", async () => {
  const onDone = vi.fn();
  await renderWizard(onDone);
  await click("Continue");
  await click("Continue");
  await click("Start fresh");
  expect(onDone).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledWith(undefined);
  expect(mocks.createProject).not.toHaveBeenCalled();
});

it("keeps setup open when saving completion fails and finishes on retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await renderWizard(onDone);
  await click("Continue");
  await click("Continue");
  await click("Start fresh");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Start fresh");
  expect(onDone).toHaveBeenCalledOnce();
});

it("shows the fresh-install AI picker and only permits provider refresh after Turn on", async () => {
  const rows = [
    "claudeAgent",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "antigravity",
    "commandCode",
    "droid",
    "devin",
    "pi",
    "muse",
  ];
  const off = Object.fromEntries(
    rows.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: false },
    ]),
  );
  mocks.config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: off },
    adminBlockedProviderDrivers: [],
  };
  appAtomRegistry.set(mocks.configAtom as Atom.Writable<WizardServerConfig | null>, mocks.config);
  mocks.detect.mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        { driver: ProviderDriverKind.make("codex"), installed: true, path: "/test/bin/codex" },
        {
          driver: ProviderDriverKind.make("claudeAgent"),
          installed: true,
          path: "/test/bin/claude",
        },
      ],
    },
  });
  const onDone = vi.fn();
  await renderWizard(onDone);
  expect(document.body.textContent).toContain("Set up ViewCode");
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.providerAction).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  await click("Continue");
  expect(document.body.textContent).toContain("Which AI tools do you use?");
  expect(document.body.textContent).toContain("Found on this computer");
  expect(mocks.detect).toHaveBeenCalledExactlyOnceWith({
    environmentId: EnvironmentId.make("test-env"),
    input: {},
  });
  const choices = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')];
  expect(choices).toHaveLength(11);
  expect(choices.every((row) => row.getAttribute("aria-checked") === "false")).toBe(true);
  const codex = document.querySelector<HTMLElement>(
    '[role="checkbox"][aria-label="Let ViewCode start Codex"]',
  );
  expect(codex).not.toBeNull();
  await act(async () => codex!.click());
  expect(codex!.getAttribute("aria-checked")).toBe("true");
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.providerAction).not.toHaveBeenCalled();
  expect(Object.values(off).every((provider) => provider.enabled === false)).toBe(true);
  await click("Turn on 1 tool");
  expect(mocks.update).toHaveBeenCalledOnce();
  const request = mocks.update.mock.calls[0]?.[0];
  expect(request?.environmentId).toBe("test-env");
  expect(request?.input.patch.providerInstances).toEqual({
    ...off,
    [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex"), enabled: true },
  });
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.providerAction).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  // Only the authoritative settings acknowledgement unlocks provider refresh.
  mocks.config = {
    ...mocks.config,
    settings: {
      ...mocks.config.settings,
      providerInstances: {
        ...off,
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    },
  };
  await act(async () => {
    appAtomRegistry.set(mocks.configAtom as Atom.Writable<WizardServerConfig | null>, mocks.config);
  });
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId: EnvironmentId.make("test-env"),
    input: {},
  });
  expect(mocks.providerAction).not.toHaveBeenCalled();
});
