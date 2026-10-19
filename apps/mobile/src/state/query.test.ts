import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({
  result: undefined as unknown,
  registry: undefined as AtomRegistry.AtomRegistry | undefined,
  refresh: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  use: () => hooks.registry,
  useCallback: (callback: () => void) => callback,
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: Symbol("registry"),
  useAtomValue: () => hooks.result,
  useAtomRefresh: () => hooks.refresh,
}));
import { useEnvironmentQuery } from "./query";

const atom = Atom.make(AsyncResult.initial<string, Error>());

beforeEach(() => {
  hooks.effects = [];
  hooks.refresh.mockReset();
  hooks.registry = AtomRegistry.make();
});

afterEach(() => hooks.registry?.dispose());

describe("useEnvironmentQuery", () => {
  it("keeps a cancelled detail load pending without a load error", () => {
    hooks.result = AsyncResult.failure(Cause.interrupt(1));
    expect(useEnvironmentQuery(atom)).toMatchObject({
      data: null,
      error: null,
      isPending: true,
      isSuccess: false,
    });
  });

  it("retains loaded data when its refresh is cancelled", () => {
    hooks.result = AsyncResult.failureWithPrevious(Cause.interrupt(1), {
      previous: Option.some(AsyncResult.success("loaded detail")),
    });
    expect(useEnvironmentQuery(atom)).toMatchObject({
      data: "loaded detail",
      error: null,
      isPending: true,
      isSuccess: false,
    });
  });
  it("reports a genuine failure even when its cause also contains an interrupt", () => {
    hooks.result = AsyncResult.failure(
      Cause.fromReasons([
        Cause.makeInterruptReason(1),
        Cause.makeFailReason(new Error("Could not reach GitHub.")),
      ]),
    );
    expect(useEnvironmentQuery(atom)).toMatchObject({
      data: null,
      error: "Could not reach GitHub.",
      isPending: false,
      isSuccess: false,
    });
  });

  it("reports defects rather than treating them as cancellation", () => {
    hooks.result = AsyncResult.failure(Cause.die(new Error("Unexpected response.")));
    expect(useEnvironmentQuery(atom)).toMatchObject({
      error: "Unexpected response.",
      isPending: false,
    });
  });

  it("keeps a genuine refresh failure and its prior data visible", () => {
    hooks.result = AsyncResult.failureWithPrevious(
      Cause.fail(new Error("Could not reach GitHub.")),
      {
        previous: Option.some(AsyncResult.success("loaded detail")),
      },
    );
    expect(useEnvironmentQuery(atom)).toMatchObject({
      data: "loaded detail",
      error: "Could not reach GitHub.",
      isPending: false,
    });
  });

  it("does not mark an absent query pending", () => {
    hooks.result = AsyncResult.failure(Cause.interrupt(1));
    expect(useEnvironmentQuery(null).isPending).toBe(false);
  });

  it("refetches an interrupted atom and exposes the recovered detail", () => {
    let reads = 0;
    const query = Atom.make(
      Effect.suspend(() => {
        reads++;
        return reads === 1 ? Effect.interrupt : Effect.succeed("recovered detail");
      }),
    );
    const registry = AtomRegistry.make();
    const unmount = registry.mount(query);
    hooks.registry = registry;
    hooks.refresh.mockImplementation(() => registry.refresh(query));
    try {
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      // The overview and files panel subscribe to the same detail atom.
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({
        data: "recovered detail",
        error: null,
        isPending: false,
        isSuccess: true,
      });
      for (const effect of hooks.effects.splice(0)) effect();
      expect(reads).toBe(2);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("retains the prior atom value until an interrupted refresh recovers", () => {
    let reads = 0;
    const query = Atom.make(
      Effect.suspend(() => {
        reads++;
        return reads === 2 ? Effect.interrupt : Effect.succeed(`detail ${reads}`);
      }),
    );
    const registry = AtomRegistry.make();
    const unmount = registry.mount(query);
    hooks.registry = registry;
    hooks.refresh.mockImplementation(() => registry.refresh(query));
    try {
      expect(Option.getOrNull(AsyncResult.value(registry.get(query)))).toBe("detail 1");
      registry.refresh(query);
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({
        data: "detail 1",
        error: null,
        isPending: true,
      });
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({
        data: "detail 3",
        error: null,
        isPending: false,
        isSuccess: true,
      });
    } finally {
      unmount();
      registry.dispose();
    }
  });
  it("stops retrying and surfaces an error when every attempt is interrupted", () => {
    let reads = 0;
    const query = Atom.make(
      Effect.suspend(() => {
        reads++;
        return Effect.interrupt;
      }),
    );
    const registry = hooks.registry!;
    const unmount = registry.mount(query);
    hooks.refresh.mockImplementation(() => registry.refresh(query));
    try {
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      const stopped = useEnvironmentQuery(query);
      expect(stopped.isPending).toBe(false);
      expect(stopped.error).toBeTruthy();
      for (const effect of hooks.effects.splice(0)) effect();
      expect(reads).toBe(2);
      // Another subscriber cannot start the failed automatic recovery again.
      expect(useEnvironmentQuery(query)).toMatchObject({ error: stopped.error, isPending: false });
      for (const effect of hooks.effects.splice(0)) effect();
      expect(reads).toBe(2);
      stopped.refresh();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({ error: stopped.error, isPending: false });
      for (const effect of hooks.effects.splice(0)) effect();
      expect(reads).toBe(4);
    } finally {
      unmount();
    }
  });
  it("allows recovery from a later interruption after a successful load", () => {
    let reads = 0;
    const query = Atom.make(
      Effect.suspend(() => {
        reads++;
        return reads % 2 === 1 ? Effect.interrupt : Effect.succeed(`detail ${reads}`);
      }),
    );
    const registry = hooks.registry!;
    const unmount = registry.mount(query);
    hooks.refresh.mockImplementation(() => registry.refresh(query));
    try {
      hooks.result = registry.get(query);
      useEnvironmentQuery(query);
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query).data).toBe("detail 2");
      for (const effect of hooks.effects.splice(0)) effect();
      registry.refresh(query);
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({ error: null, isPending: true });
      for (const effect of hooks.effects.splice(0)) effect();
      hooks.result = registry.get(query);
      expect(useEnvironmentQuery(query)).toMatchObject({
        data: "detail 4",
        error: null,
        isPending: false,
      });
      expect(reads).toBe(4);
    } finally {
      unmount();
    }
  });
});
