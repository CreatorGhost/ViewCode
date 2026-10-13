import * as NodeModule from "node:module";
import type {
  StackNavigationState,
  StackRouter as StackRouterType,
  StackActions as StackActionsType,
} from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

function loadRouters() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
  const requireFromCore = NodeModule.createRequire(corePackage);
  return requireFromCore("@react-navigation/routers") as {
    readonly StackActions: typeof StackActionsType;
    readonly StackRouter: typeof StackRouterType;
  };
}

vi.mock("@react-navigation/native", () => {
  const { StackActions } = loadRouters();
  return { StackActions };
});

import { resolveVoiceInputThreadReturn } from "./voiceInputReturn";

const { StackRouter } = loadRouters();
const routeNames = ["Home", "Thread", "ThreadFile", "SettingsSheet"];
const router = StackRouter({});
const routerOptions = {
  routeNames,
  routeParamList: { Home: undefined, Thread: undefined, ThreadFile: undefined },
  routeGetIdList: {},
};
const thread = { environmentId: "env-1", threadId: "thread-1" };

function stackState(
  routes: ReadonlyArray<{ readonly name: string; readonly params?: object }>,
): StackNavigationState<Record<string, object | undefined>> {
  return {
    stale: false,
    type: "stack",
    key: "root",
    index: routes.length - 1,
    routeNames,
    preloadedRoutes: [],
    routes: routes.map((route, index) => ({ key: `${route.name}-${index}`, ...route })),
  };
}

function navigateBack(state: ReturnType<typeof stackState>) {
  const action = resolveVoiceInputThreadReturn(state, thread);
  if (!action) return null;
  const next = router.getStateForAction(state, action, routerOptions);
  return next?.routes.map((route) => [route.name, route.params ?? null]);
}

describe("resolveVoiceInputThreadReturn", () => {
  it("returns down the stack to the dictating thread", () => {
    expect(
      navigateBack(
        stackState([
          { name: "Home" },
          { name: "Thread", params: thread },
          { name: "ThreadFile", params: { ...thread, path: "a.ts" } },
          { name: "SettingsSheet" },
        ]),
      ),
    ).toEqual([
      ["Home", null],
      ["Thread", thread],
    ]);
  });

  it("opens the thread when it has left the stack", () => {
    expect(
      navigateBack(
        stackState([
          { name: "Home" },
          { name: "Thread", params: { environmentId: "env-1", threadId: "thread-2" } },
        ]),
      ),
    ).toEqual([
      ["Home", null],
      ["Thread", { environmentId: "env-1", threadId: "thread-2" }],
      ["Thread", thread],
    ]);
  });

  it("does nothing when the thread is already on screen", () => {
    expect(
      resolveVoiceInputThreadReturn(
        stackState([{ name: "Home" }, { name: "Thread", params: thread }]),
        thread,
      ),
    ).toBeNull();
  });

  it("does nothing before navigation is ready", () => {
    expect(resolveVoiceInputThreadReturn(undefined, thread)).toBeNull();
  });
});
