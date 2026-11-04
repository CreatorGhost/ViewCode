import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import { guardAcpRegistryPrepare } from "./acpRegistryPolicy.ts";

it.effect("blocks registry setup for blocked drivers and permits an explicit allowed setup", () =>
  Effect.gen(function* () {
    const prepared: Array<string> = [];
    const prepare = guardAcpRegistryPrepare((input) =>
      Effect.sync(() => {
        prepared.push(input.agentId);
      }),
    );
    const blocked = yield* prepare({ agentId: "factory-droid" }).pipe(Effect.result);
    assert.equal(blocked._tag, "Failure");
    yield* prepare({ agentId: "devin" });
    yield* prepare({ agentId: "devin" }).pipe(
      Effect.result,
      Effect.provideService(AdminPolicyRef, {
        blockedDrivers: ["acpRegistry"],
        tailscaleBlocked: false,
        problem: null,
      }),
    );
    assert.deepEqual(prepared, ["devin"]);
  }).pipe(
    Effect.provideService(AdminPolicyRef, {
      blockedDrivers: ["droid"],
      tailscaleBlocked: false,
      problem: null,
    }),
  ),
);
