import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AdminProviderPolicyRef } from "../AdminProviderPolicy.ts";
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
      Effect.provideService(AdminProviderPolicyRef, {
        blockedDrivers: ["acpRegistry"],
        problem: null,
      }),
    );
    assert.deepEqual(prepared, ["devin"]);
  }).pipe(
    Effect.provideService(AdminProviderPolicyRef, { blockedDrivers: ["droid"], problem: null }),
  ),
);
