import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { StrictMode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const state = vi.hoisted(() => ({ refresh: vi.fn(async () => ({ _tag: "Success" })) }));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
import { useUsageRefreshOnOpen } from "./useUsageRefreshOnOpen";

const now = Date.parse("2026-09-28T10:00:00Z");
let serial = 0;
let environmentId: EnvironmentId;
const renderers: ReactTestRenderer[] = [];
function entries(age = 120_000, enabled = true) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: new Date(now - age).toISOString(),
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: { checkedAt: new Date(now - age).toISOString(), windows: [] },
    },
  ]);
}
function Panel({ age, enabled }: { age?: number; enabled?: boolean }) {
  const result = useUsageRefreshOnOpen(environmentId, entries(age, enabled));
  return <span>{result.error ?? (result.refreshing.size ? "Checking" : "Ready")}</span>;
}
async function mount(age?: number, enabled?: boolean) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Panel
          {...(age === undefined ? {} : { age })}
          {...(enabled === undefined ? {} : { enabled })}
        />
      </StrictMode>,
    );
  });
  renderers.push(renderer);
  return renderer;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(now);
  environmentId = EnvironmentId.make(`usage-refresh-${++serial}`);
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses fresh cached readings and never probes a disabled provider", async () => {
  await mount(10_000);
  await mount(120_000, false);
  expect(state.refresh).not.toHaveBeenCalled();
});
it("coalesces simultaneous panels and StrictMode into one stale refresh", async () => {
  let finish!: (result: { _tag: string }) => void;
  state.refresh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = await mount();
  const second = await mount();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(first.root.findByType("span").children).toEqual(["Checking"]);
  expect(second.root.findByType("span").children).toEqual(["Checking"]);
  await act(async () => {
    finish({ _tag: "Success" });
  });
  expect(second.root.findByType("span").children).toEqual(["Ready"]);
  await mount();
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
it("shows failures, avoids repeated retries on reopen, and retries after a minute", async () => {
  state.refresh.mockResolvedValue({ _tag: "Failure" });
  const panel = await mount();
  expect(panel.root.findByType("span").children.join("")).toContain("Could not refresh");
  await mount();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(now + 61_000);
  await mount();
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
it("does not share freshness between environments", async () => {
  await mount();
  const firstId = environmentId;
  environmentId = EnvironmentId.make(`usage-refresh-${++serial}`);
  await mount();
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(state.refresh).toHaveBeenNthCalledWith(1, {
    environmentId: firstId,
    input: { instanceId: "codex" },
  });
  expect(state.refresh).toHaveBeenNthCalledWith(2, {
    environmentId,
    input: { instanceId: "codex" },
  });
});
