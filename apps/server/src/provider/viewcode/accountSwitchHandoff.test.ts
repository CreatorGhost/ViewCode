import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { makeClaudeContinuationGroupKey } from "../Drivers/ClaudeHome.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSwitch from "../../orchestration-v2/ProviderSwitchService.ts";

const decodeCodex = Schema.decodeSync(CodexSettings);
const decodeClaude = Schema.decodeSync(ClaudeSettings);
const primary = ProviderInstanceId.make("personal");
const target = ProviderInstanceId.make("work");
const sessionId = ProviderSessionId.make("personal-session");
const now = DateTime.makeUnsafe("2026-10-18T00:00:00.000Z");
const projection = {
  thread: {
    id: ThreadId.make("account-switch"),
    modelSelection: { instanceId: primary, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: "/workspace",
  },
  providerSessions: [
    {
      id: sessionId,
      providerInstanceId: primary,
      status: "ready",
      cwd: "/workspace",
      capabilities: CodexProviderCapabilitiesV2,
      updatedAt: now,
    },
  ],
  providerThreads: [],
} as unknown as OrchestrationV2ThreadProjection;

const switchPlan = (driverName: string, currentKey: string, targetKey: string) => {
  const driver = ProviderDriverKind.make(driverName);
  const adapter = (instanceId: ProviderInstanceId): ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("The planning service must not start a provider."),
  });
  return Effect.gen(function* () {
    const service = yield* ProviderSwitch.ProviderSwitchServiceV2;
    return yield* service.plan({
      projection,
      targetModelSelection: { instanceId: target, model: "default" },
    });
  }).pipe(
    Effect.provide(
      ProviderSwitch.layer.pipe(
        Layer.provide(
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            get: (id) => Effect.succeed(adapter(id)),
            getMetadata: (id) =>
              Effect.succeed({
                driver,
                enabled: true,
                continuationKey: id === primary ? currentKey : targetKey,
                capabilities: CodexProviderCapabilitiesV2,
              }),
          }),
        ),
      ),
    ),
  );
};

describe("ViewCode accounts on upstream provider switching", () => {
  it.effect("restarts a Codex auth-overlay account against its shared native history", () =>
    Effect.gen(function* () {
      const personal = yield* resolveCodexHomeLayout(
        decodeCodex({ homePath: "/accounts/shared", shadowHomePath: "/accounts/personal" }),
      );
      const work = yield* resolveCodexHomeLayout(
        decodeCodex({ homePath: "/accounts/shared", shadowHomePath: "/accounts/work" }),
      );
      assert.notEqual(personal.effectiveHomePath, work.effectiveHomePath);
      const plan = yield* switchPlan("codex", personal.continuationKey, work.continuationKey);
      assert.equal(plan.transition.type, "restart_and_resume");
      assert.deepEqual(plan.releaseProviderSessionIds, [sessionId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses portable handoff when switching isolated Claude account homes", () =>
    Effect.gen(function* () {
      const personal = yield* makeClaudeContinuationGroupKey(
        decodeClaude({ homePath: "/accounts/claude-personal" }),
      );
      const work = yield* makeClaudeContinuationGroupKey(
        decodeClaude({ homePath: "/accounts/claude-work" }),
      );
      const plan = yield* switchPlan("claudeAgent", personal, work);
      assert.equal(plan.transition.type, "create_with_handoff");
      assert.isNull(plan.targetProviderThreadId);
      assert.deepEqual(plan.releaseProviderSessionIds, [sessionId]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
