import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadTabsStore } from "../../threadTabsStore";
import { buildThreadTabActions } from "./threadTabActions";

const ref = (environment: string, thread: string) => ({
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make(thread),
});
const left = ref("local", "same-id");
const right = ref("remote", "same-id");
const rightNext = ref("remote", "next");
const key = scopedThreadKey;

beforeEach(() => {
  useThreadTabsStore.setState({ tabsByEnvironmentId: {}, recentThreadKeys: [] });
});

describe("thread tab palette actions", () => {
  it("moves within the focused split pane's environment, even when thread IDs overlap", async () => {
    const store = useThreadTabsStore.getState();
    store.open(left.environmentId, key(left));
    store.open(right.environmentId, key(right));
    store.open(rightNext.environmentId, key(rightNext));
    const navigate = vi.fn();
    const home = vi.fn();
    const actions = buildThreadTabActions(right, navigate, home);
    await actions.find((action) => action.value === "action:tab-next")!.run();
    expect(navigate).toHaveBeenLastCalledWith(rightNext);
    expect(home).not.toHaveBeenCalled();
    expect(useThreadTabsStore.getState().tabsByEnvironmentId.local).toEqual([key(left)]);
  });

  it("closes only the selected environment's tab and opens its remaining neighbour", async () => {
    const store = useThreadTabsStore.getState();
    store.open(left.environmentId, key(left));
    store.open(right.environmentId, key(right));
    store.open(rightNext.environmentId, key(rightNext));
    const navigate = vi.fn();
    const home = vi.fn();
    await buildThreadTabActions(right, navigate, home)
      .find((action) => action.value === "action:tab-close")!
      .run();
    expect(navigate).toHaveBeenCalledWith(rightNext);
    expect(useThreadTabsStore.getState().tabsByEnvironmentId).toEqual({
      local: [key(left)],
      remote: [key(rightNext)],
    });
    expect(home).not.toHaveBeenCalled();
  });

  it("returns home after the last tab and offers no thread actions on draft routes", async () => {
    useThreadTabsStore.getState().open(right.environmentId, key(right));
    const navigate = vi.fn();
    const home = vi.fn();
    const actions = buildThreadTabActions(right, navigate, home);
    expect(actions.map((action) => action.value)).toEqual(["action:tab-close"]);
    await actions[0]!.run();
    expect(navigate).not.toHaveBeenCalled();
    expect(home).toHaveBeenCalledOnce();
    expect(buildThreadTabActions(null, navigate, home)).toEqual([]);
  });
});
