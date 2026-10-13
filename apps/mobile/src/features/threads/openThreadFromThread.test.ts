import * as NodeModule from "node:module";
import type { StackActions as StackActionsType } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

// The real routers package; the React Native entry of @react-navigation/native does not load in Node.
vi.mock("@react-navigation/native", () => {
  const require = NodeModule.createRequire(import.meta.url);
  const requireFromNative = NodeModule.createRequire(
    require.resolve("@react-navigation/native/package.json"),
  );
  const requireFromCore = NodeModule.createRequire(
    requireFromNative.resolve("@react-navigation/core/package.json"),
  );
  return requireFromCore("@react-navigation/routers") as {
    readonly StackActions: typeof StackActionsType;
  };
});

import { openThreadFromThreadAction } from "./openThreadFromThread";

const thread = (threadId: string) => ({
  key: `Thread-${threadId}`,
  name: "Thread",
  params: { environmentId: "env", threadId },
});
const home = { key: "Home", name: "Home" };

describe("opening a thread from a thread", () => {
  it("pushes a thread that is not in the stack", () => {
    const action = openThreadFromThreadAction(
      { index: 1, routes: [home, thread("parent")] },
      { environmentId: "env", threadId: "child" },
    );
    expect(action).toMatchObject({ type: "PUSH", payload: { name: "Thread" } });
  });

  it("pops back to a thread already below instead of stacking it again", () => {
    const action = openThreadFromThreadAction(
      { index: 3, routes: [home, thread("parent"), thread("child"), thread("other")] },
      { environmentId: "env", threadId: "parent" },
    );
    expect(action).toMatchObject({ type: "POP", payload: { count: 2 } });
  });

  it("does nothing for the thread already on screen", () => {
    expect(
      openThreadFromThreadAction(
        { index: 1, routes: [home, thread("parent")] },
        { environmentId: "env", threadId: "parent" },
      ),
    ).toBeNull();
  });

  it("does not match the same thread id in another environment", () => {
    const action = openThreadFromThreadAction(
      { index: 2, routes: [home, thread("parent"), thread("child")] },
      { environmentId: "other-env", threadId: "parent" },
    );
    expect(action).toMatchObject({ type: "PUSH" });
  });
});
