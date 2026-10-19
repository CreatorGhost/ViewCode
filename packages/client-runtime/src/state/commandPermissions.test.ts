import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthAccessWriteScope,
  AuthProvidersManageScope,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { NetworkStatus } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

const viewCodeMutations = [
  [WS_METHODS.agentsStop, AuthOrchestrationOperateScope],
  [WS_METHODS.agentsResume, AuthOrchestrationOperateScope],
  [WS_METHODS.agentsDiscard, AuthOrchestrationOperateScope],
  [WS_METHODS.usageResumeCancel, AuthOrchestrationOperateScope],
  [WS_METHODS.usageResumeNow, AuthOrchestrationOperateScope],
  [WS_METHODS.providerAccountAdd, AuthSettingsWriteScope],
  [WS_METHODS.providerAccountPrepareSignIn, AuthProvidersManageScope],
  [WS_METHODS.viewcodeRelaySetupStart, AuthAccessWriteScope],
  [WS_METHODS.viewcodeRelaySetupCancel, AuthAccessWriteScope],
  [WS_METHODS.viewcodeRelaySetupContinue, AuthAccessWriteScope],
  [WS_METHODS.viewcodeRelaySetupChooseAccount, AuthAccessWriteScope],
  [WS_METHODS.viewcodeRelayRemove, AuthAccessWriteScope],
  [WS_METHODS.pullRequestsStartReview, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewStartFixThread, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewStartLocal, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewPostFindings, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewRateFinding, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewUndoFixes, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewLearnStyle, AuthOrchestrationOperateScope],
  [WS_METHODS.reviewForgetLearnedStyle, AuthOrchestrationOperateScope],
  [WS_METHODS.voiceModelsDownload, AuthOrchestrationOperateScope],
  [WS_METHODS.voiceModelsCancel, AuthOrchestrationOperateScope],
  [WS_METHODS.voiceModelsRemove, AuthOrchestrationOperateScope],
  [WS_METHODS.pushRegister, AuthOrchestrationReadScope],
  [WS_METHODS.pushUnregister, AuthOrchestrationReadScope],
] as const;

const withScope = (scope: AuthEnvironmentScope): AuthSessionState => ({
  ...grant(false),
  scopes: [scope],
  permissions: [scope],
});

it.effect.each(viewCodeMutations)(
  "rechecks %s against its destination grant after revocation",
  ([method, scope]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const protectedCommand = createCommandPermissions(runtime, method);
        expect(protectedCommand.requiredScopes()).toEqual([scope]);
        registry.mount(protectedCommand.permissionAtom(env));
        registry.mount(protectedCommand.permissionAtom(other));
        registry.set(sessions(env), AsyncResult.success(withScope(scope)));
        registry.set(sessions(other), AsyncResult.success(withScope(scope)));
        expect(registry.get(protectedCommand.permissionAtom(env))).toBe(true);
        yield* protectedCommand.authorize(registry, env);
        registry.set(sessions(env), AsyncResult.success({ ...withScope(scope), permissions: [] }));
        expect(registry.get(sessions(env))).toMatchObject({ value: { permissions: [] } });
        const denied = yield* protectedCommand.authorize(registry, env).pipe(Effect.flip);
        expect(registry.get(protectedCommand.permissionAtom(env))).toBe(false);
        expect(registry.get(protectedCommand.permissionAtom(other))).toBe(true);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: scope,
        });
      }),
    ),
);

const routedMutations = [
  {
    tag: WS_METHODS.usageResumeNow,
    scope: AuthOrchestrationOperateScope,
    input: { threadId: ThreadId.make("usage-thread") },
    result: { changed: true },
  },
  {
    tag: WS_METHODS.providerAccountAdd,
    scope: AuthSettingsWriteScope,
    input: {
      driver: "codex",
      instanceId: ProviderInstanceId.make("account"),
      displayName: "Second account",
    },
    result: { instanceId: ProviderInstanceId.make("account"), homePath: "/isolated/account" },
  },
  {
    tag: WS_METHODS.providerAccountPrepareSignIn,
    scope: AuthProvidersManageScope,
    input: { instanceId: ProviderInstanceId.make("account") },
    result: {
      instanceId: ProviderInstanceId.make("account"),
      cwd: "/isolated/login",
      command: "codex login",
    },
  },
  {
    tag: WS_METHODS.viewcodeRelaySetupCancel,
    scope: AuthAccessWriteScope,
    input: {},
    result: undefined,
  },
  {
    tag: WS_METHODS.pushUnregister,
    scope: AuthOrchestrationReadScope,
    input: {},
    result: { changed: true },
  },
] as const;

it.effect.each(routedMutations)(
  "blocks $tag at the actual RPC destination while the origin remains authorized",
  (test) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        let calls = 0;
        const session = {
          client: {
            [test.tag]: () =>
              Effect.sync(() => {
                calls++;
                return test.result;
              }),
          },
        } as unknown as RpcSession;
        const supervisor = {
          target: { environmentId: other, label: "routed destination" },
          session: yield* SubscriptionRef.make(Option.some(session)),
        } as unknown as EnvironmentSupervisor["Service"];
        const routedRuntime = Atom.runtime(
          Layer.mock(EnvironmentRegistry)({
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map()),
            networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
            run: (_id, task) => Effect.provideService(task, EnvironmentSupervisor, supervisor),
          }),
        );
        const command = createEnvironmentRpcCommand(routedRuntime, {
          label: `test.${test.tag}`,
          tag: test.tag,
        });
        registry.set(sessions(env), AsyncResult.success(withScope(test.scope)));
        registry.set(sessions(other), AsyncResult.success(withScope(test.scope)));
        const target = { environmentId: env, input: test.input };
        expect((yield* Effect.promise(() => command.run(registry, target)))._tag).toBe("Success");
        expect(calls).toBe(1);
        registry.set(
          sessions(other),
          AsyncResult.success({ ...withScope(test.scope), permissions: [] }),
        );
        expect(registry.get(command.permissionAtom(env, test.input))).toBe(true);
        expect((yield* Effect.promise(() => command.run(registry, target)))._tag).toBe("Failure");
        expect(calls).toBe(1);
      }),
    ),
);
