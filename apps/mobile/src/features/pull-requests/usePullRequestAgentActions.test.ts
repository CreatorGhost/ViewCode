import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PullRequestDetail } from "@t3tools/contracts";
import { usePullRequestAgentActions } from "./usePullRequestAgentActions";

const state = vi.hoisted(() => ({
  connected: false,
  canAsk: true,
  isPending: true,
  ask: vi.fn(),
}));
vi.mock("./usePullRequestConnected", () => ({
  usePullRequestConnected: () => state.connected,
}));
vi.mock("./usePullRequestThreads", () => ({
  usePullRequestThreads: () => ({
    threads: [],
    canAsk: state.canAsk,
    canWatch: true,
    busy: false,
    isPending: state.isPending,
    ask: state.ask,
  }),
}));
const params = {
  environmentId: "environment",
  projectId: "project",
  repository: "owner/repo",
  number: 1,
};
const pr = { state: "open", mergeability: "conflicting" } as PullRequestDetail;

beforeEach(() => {
  state.connected = false;
  state.canAsk = true;
  state.isPending = true;
  state.ask.mockClear();
});

describe("PR agent drafts", () => {
  // ViewCode retains connected PR workflows; upstream's offline draft redesign is excluded.
  it.each([false, true])("waits for linked-thread discovery (connected: %s)", (connected) => {
    state.connected = connected;
    const actions = usePullRequestAgentActions(params, pr);
    expect(actions.disabled).toBe(true);
    actions.start("ask");
    actions.start("explain");
    expect(state.ask).not.toHaveBeenCalled();
  });

  it("opens a new draft once linked-thread discovery is ready", () => {
    state.connected = true;
    state.isPending = false;
    const actions = usePullRequestAgentActions(params, pr);
    expect(actions.disabled).toBe(false);
    actions.start("ask");
    actions.start("explain");
    expect(state.ask.mock.calls).toEqual([
      [undefined, "ask"],
      [undefined, "explain"],
    ]);
  });

  it("does not open drafts when the connection denies task access", () => {
    state.connected = true;
    state.canAsk = false;
    state.isPending = false;
    usePullRequestAgentActions(params, pr).start("explain");
    expect(state.ask).not.toHaveBeenCalled();
  });
});
