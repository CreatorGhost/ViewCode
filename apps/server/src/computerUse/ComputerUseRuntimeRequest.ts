import type { ProviderApprovalDecision, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComputerUse from "./ComputerUseService.ts";

/** RuntimeRequestService reads this once when constructed; the default refuses stale requests. */
export const ComputerUseRuntimeRequest = Context.Reference<
  (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly decision: ProviderApprovalDecision;
  }) => Effect.Effect<boolean>
>("t3/computerUse/ComputerUseRuntimeRequest", { defaultValue: () => () => Effect.succeed(false) });

export const layer = Layer.effect(
  ComputerUseRuntimeRequest,
  Effect.gen(function* () {
    const computer = yield* ComputerUse.ComputerUseService;
    return (input: {
      readonly threadId: ThreadId;
      readonly requestId: RuntimeRequestId;
      readonly decision: ProviderApprovalDecision;
    }) => computer.respondToApproval(input).pipe(Effect.map((result) => result === "handled"));
  }),
);
