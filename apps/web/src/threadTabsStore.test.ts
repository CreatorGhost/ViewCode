import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useThreadTabsStore } from "./threadTabsStore";

const key = (environment: string, thread: string) =>
  scopedThreadKey({
    environmentId: EnvironmentId.make(environment),
    threadId: ThreadId.make(thread),
  });
const reset = () => useThreadTabsStore.setState({ tabsByEnvironmentId: {}, recentThreadKeys: [] });
afterEach(reset);

describe("visible open thread tabs", () => {
  it("closes local selection and chooses its neighbour without changing another environment's tabs", () => {
    reset();
    const first = key("local", "first"),
      active = key("local", "same-id"),
      next = key("local", "next"),
      remote = key("remote", "same-id");
    const tabs = useThreadTabsStore.getState();
    tabs.open("local", first);
    tabs.open("local", active);
    tabs.open("local", next);
    tabs.open("remote", remote);
    expect(tabs.close("local", active, active)).toBe(next);
    expect(useThreadTabsStore.getState().tabsByEnvironmentId).toEqual({
      local: [first, next],
      remote: [remote],
    });
    expect(useThreadTabsStore.getState().recentThreadKeys).not.toContain(active);
    expect(useThreadTabsStore.getState().recentThreadKeys).toContain(remote);
    tabs.open("local", active);
    expect(useThreadTabsStore.getState().tabsByEnvironmentId.local).toContain(active);
  });

  it("closing the last local tab returns to the landing selection and leaves the thread reopenable", () => {
    reset();
    const thread = key("local", "thread");
    const tabs = useThreadTabsStore.getState();
    tabs.open("local", thread);
    expect(tabs.close("local", thread, thread)).toBeNull();
    expect(useThreadTabsStore.getState().tabsByEnvironmentId.local).toEqual([]);
    tabs.open("local", thread);
    expect(useThreadTabsStore.getState().tabsByEnvironmentId.local).toEqual([thread]);
  });
});
