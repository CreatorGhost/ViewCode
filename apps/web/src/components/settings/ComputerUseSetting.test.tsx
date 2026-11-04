import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ComputerUseStatus } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environmentId: "computer-env-a",
  status: vi.fn(),
  activity: vi.fn(),
  trust: vi.fn(),
  openSettings: vi.fn(async () => true),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => "computer-env-a" }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { getComputerUseStatus: "status", getComputerUseActivity: "activity" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) =>
    (command === "status" ? mocks.status : mocks.activity)(input),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: { environmentId: mocks.environmentId } }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    select({ ...DEFAULT_SERVER_SETTINGS, computerUse: "control" }),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    status,
    control,
    settingKeys,
    children,
  }: {
    status?: ReactNode;
    control?: ReactNode;
    settingKeys?: unknown;
    children?: ReactNode;
  }) => (
    <section>
      {status}
      {settingKeys ? null : control}
      {children}
    </section>
  ),
  SettingResetButton: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { Button } from "../ui/button";
import { ComputerUseSetting } from "./ComputerUseSetting";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const statusValue = (reason?: string): ComputerUseStatus => ({
  mode: "control",
  platform: "darwin",
  driverAvailable: reason === undefined,
  accessibility: "granted",
  ...(reason ? { reason } : {}),
});
const success = <Value,>(value: Value) => ({ _tag: "Success" as const, value });
let renderer: ReactTestRenderer;
function mount() {
  act(() => {
    renderer = create(<ComputerUseSetting />);
  });
}
function click(label: string) {
  const button = renderer.root.findAllByType(Button).find((node) => node.props.children === label);
  expect(button).toBeDefined();
  act(() => button!.props.onClick?.());
}
function visibleText() {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.environmentId = "computer-env-a";
  mocks.status.mockReset();
  mocks.activity.mockReset();
  mocks.trust.mockReset();
  mocks.openSettings.mockClear();
  mocks.trust.mockResolvedValue(true);
  vi.stubGlobal("window", {
    desktopBridge: {
      getClientPlatform: () => "darwin",
      openSystemSettings: mocks.openSettings,
      checkSystemPermission: mocks.trust,
    },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("loads status once and refreshes explicitly despite changing command callback identities", async () => {
  const first = deferred<ReturnType<typeof success<ComputerUseStatus>>>();
  const second = deferred<ReturnType<typeof success<ComputerUseStatus>>>();
  mocks.status.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount();
  expect(mocks.status).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(success(statusValue())));
  expect(visibleText()).toContain("Accessibility granted");
  expect(mocks.status).toHaveBeenCalledTimes(1);
  await act(async () => click("Check again"));
  expect(mocks.status).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve(success(statusValue("Driver stopped"))));
  expect(visibleText()).toContain("Driver stopped");
  expect(mocks.status.mock.calls.map(([input]) => input.environmentId)).toEqual([
    EnvironmentId.make("computer-env-a"),
    EnvironmentId.make("computer-env-a"),
  ]);
});

it("ignores an old environment's deferred status after selection changes", async () => {
  const first = deferred<ReturnType<typeof success<ComputerUseStatus>>>();
  const second = deferred<ReturnType<typeof success<ComputerUseStatus>>>();
  mocks.status.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount();
  mocks.environmentId = "computer-env-b";
  act(() => renderer.update(<ComputerUseSetting />));
  expect(mocks.status.mock.calls.map(([input]) => input.environmentId)).toEqual([
    "computer-env-a",
    "computer-env-b",
  ]);
  await act(async () => second.resolve(success(statusValue("Selected environment"))));
  await act(async () => first.resolve(success(statusValue("Stale environment"))));
  expect(visibleText()).toContain("Selected environment");
  expect(visibleText()).not.toContain("Stale environment");
});

it("keeps a newer trust result when the initial macOS permission request completes later", async () => {
  const initialTrust = deferred<boolean>();
  const checkedTrust = deferred<boolean>();
  mocks.trust.mockReturnValueOnce(initialTrust.promise).mockReturnValueOnce(checkedTrust.promise);
  mocks.status.mockResolvedValue(success(statusValue("Driver stopped")));
  mount();
  await act(async () => {});
  click("Check again");
  await act(async () => checkedTrust.resolve(true));
  await act(async () => initialTrust.resolve(false));
  expect(visibleText()).toContain("Driver stopped");
  expect(visibleText()).not.toContain("Turn on ViewCode");
  expect(mocks.openSettings).not.toHaveBeenCalled();
  expect(mocks.status).toHaveBeenCalledTimes(2);
});

it("keeps activity lazy and does not refetch when its response updates the display", async () => {
  mocks.status.mockResolvedValue(success(statusValue()));
  const activity = deferred<ReturnType<typeof success<{ entries: [] }>>>();
  mocks.activity.mockReturnValue(activity.promise);
  mount();
  await act(async () => {});
  expect(mocks.activity).not.toHaveBeenCalled();
  click("Show");
  expect(mocks.activity).toHaveBeenCalledOnce();
  await act(async () => activity.resolve(success({ entries: [] })));
  expect(mocks.activity).toHaveBeenCalledOnce();
  expect(visibleText()).toContain("No computer actions");
});
