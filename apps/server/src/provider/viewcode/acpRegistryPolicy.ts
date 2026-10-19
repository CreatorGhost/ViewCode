import { AcpRegistryOperationError, type AcpRegistryPrepareInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import { driverForRegistryAgent } from "./providerPolicyDrivers.ts";

/** Explicit setup may enable a user's disabled provider, but never an IT-blocked driver. */
export function guardAcpRegistryPrepare<A, E, R>(
  prepare: (input: AcpRegistryPrepareInput) => Effect.Effect<A, E, R>,
): (input: AcpRegistryPrepareInput) => Effect.Effect<A, E | AcpRegistryOperationError, R> {
  return (input) =>
    Effect.gen(function* () {
      const policy = yield* AdminPolicyRef;
      const driver = driverForRegistryAgent(input.agentId);
      if (policy.blockedDrivers.includes("acpRegistry") || policy.blockedDrivers.includes(driver)) {
        return yield* new AcpRegistryOperationError({
          reason: "runner_unavailable",
          message: "Blocked by your organization.",
        });
      }
      return yield* prepare(input);
    });
}
