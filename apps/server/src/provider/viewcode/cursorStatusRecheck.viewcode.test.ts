// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  RpcClientId,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type HostPowerSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";
import * as CursorStatusRecheck from "./cursorStatusRecheck.ts";

const NOW = DateTime.makeUnsafe("2026-10-22T09:00:00.000Z");

const awake: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: NOW,
};

const lease = (overrides: Partial<ClientActivityLease> = {}): ClientActivityLease => ({
  sessionId: AuthSessionId.make("session-1"),
  rpcClientId: RpcClientId.make(1),
  clientId: "desktop-window",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  scopes: [{ type: "provider-status" }],
  updatedAt: NOW,
  expiresAt: DateTime.add(NOW, { seconds: 45 }),
  ...overrides,
});

const policy = (overrides: Partial<BackgroundPolicySnapshot> = {}): BackgroundPolicySnapshot => ({
  hostPower: awake,
  leases: [lease()],
  activeForegroundLeaseCount: 1,
  activeScopeKeys: ["provider-status"],
  shouldRunOpportunisticWork: true,
  updatedAt: NOW,
  ...overrides,
});

describe("cursorRecheckTrigger", () => {
  it("fires on wake, unlock, a client back in front and a network back online", () => {
    const { cursorRecheckTrigger } = CursorStatusRecheck;
    assert.equal(
      cursorRecheckTrigger(policy({ hostPower: { ...awake, suspended: true } }), policy()),
      "wake",
    );
    assert.equal(
      cursorRecheckTrigger(policy({ hostPower: { ...awake, locked: "true" } }), policy()),
      "wake",
    );
    assert.equal(
      cursorRecheckTrigger(policy({ activeForegroundLeaseCount: 0, leases: [] }), policy()),
      "foreground",
    );
    assert.equal(
      cursorRecheckTrigger(
        policy({ leases: [lease({ networkType: "offline" })] }),
        policy({ leases: [lease({ networkType: "online" })] }),
      ),
      "network",
    );
  });

  it("stays quiet for the periodic reports in between", () => {
    const { cursorRecheckTrigger } = CursorStatusRecheck;
    assert.isUndefined(cursorRecheckTrigger(policy(), policy()));
    assert.isUndefined(
      cursorRecheckTrigger(policy(), policy({ hostPower: { ...awake, suspended: true } })),
    );
    assert.isUndefined(
      cursorRecheckTrigger(policy(), policy({ activeForegroundLeaseCount: 0, leases: [] })),
    );
    const offline = policy({ leases: [lease({ networkType: "offline" })] });
    assert.isUndefined(cursorRecheckTrigger(offline, offline));
  });
});

const provider = (
  driver: string,
  instanceId: string,
  status: ServerProvider["status"],
): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(instanceId),
  enabled: true,
  installed: true,
  version: "2026.10.01",
  status,
  checkedAt: "2026-10-22T08:00:00.000Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
});

// The stale Cursor instance is last, so one refreshed by mistake shows up before it.
const PROVIDERS = [
  provider("cursor", "cursor_ok", "ready"),
  provider("codex", "codex_stale", "warning"),
  provider("cursor", "cursor_stale", "warning"),
];

describe("CursorStatusRecheck.layer", () => {
  it.effect("re-checks a Cursor status that is not ready on focus, network return and wake", () =>
    Effect.gen(function* () {
      const refreshed = yield* Queue.unbounded<ProviderInstanceId>();
      const powerChanges = yield* PubSub.sliding<HostPowerSnapshot>(1);
      let power = awake;
      const layerPower = Layer.succeed(
        HostPowerMonitor.HostPowerMonitor,
        HostPowerMonitor.HostPowerMonitor.of({
          snapshot: Effect.sync(() => power),
          report: (next) =>
            Effect.sync(() => {
              power = next;
            }).pipe(Effect.andThen(PubSub.publish(powerChanges, next)), Effect.asVoid),
          streamChanges: Stream.fromPubSub(powerChanges),
        }),
      );
      const layerPolicy = BackgroundPolicy.layer.pipe(
        Layer.provideMerge(Layer.merge(layerPower, ServerSettings.layerTest())),
      );
      const layerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(PROVIDERS),
        refreshInstance: (instanceId) =>
          Queue.offer(refreshed, instanceId).pipe(Effect.as(PROVIDERS)),
      });

      yield* Effect.gen(function* () {
        const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
        const hostPower = yield* HostPowerMonitor.HostPowerMonitor;
        const report = (networkType: string) =>
          backgroundPolicy.reportClientActivity(
            AuthSessionId.make("session-1"),
            RpcClientId.make(1),
            {
              clientId: "desktop-window",
              clientKind: "desktop-renderer",
              visible: true,
              focused: true,
              recentlyInteracted: true,
              networkType,
              scopes: [{ type: "provider-status" }],
              ttlMs: 45_000,
              observedAt: NOW,
            },
          );

        // The window comes to the front while Wi-Fi is still joining.
        yield* report("offline");
        assert.equal(yield* Queue.take(refreshed), "cursor_stale");
        yield* report("online");
        assert.equal(yield* Queue.take(refreshed), "cursor_stale");
        // Lid closed, then opened.
        yield* hostPower.report({ ...awake, suspended: true });
        yield* hostPower.report({ ...awake, suspended: false });
        assert.equal(yield* Queue.take(refreshed), "cursor_stale");
      }).pipe(
        Effect.provide(
          CursorStatusRecheck.layer.pipe(
            Layer.provideMerge(Layer.merge(layerPolicy, layerRegistry)),
          ),
        ),
      );
    }),
  );

  it("is part of the server's runtime layers", () => {
    const server = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "..", "..", "server.ts"),
      "utf8",
    );
    assert.include(server, "CursorStatusRecheck.layer,");
  });
});
