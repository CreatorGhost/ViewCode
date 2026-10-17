import { AgentControlError, WS_METHODS, type UsageResumeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as UsageResume from "../agents/UsageResume.ts";
export const make = Effect.gen(function* () {
  const service = yield* UsageResume.UsageResume;
  return {
    [WS_METHODS.usageResumeCancel]: (input: UsageResumeInput) =>
      service.cancel(input.threadId).pipe(Effect.map((changed) => ({ changed }))),
    [WS_METHODS.usageResumeNow]: (input: UsageResumeInput) =>
      service.resumeNow(input.threadId).pipe(
        Effect.map((changed) => ({ changed })),
        Effect.mapError((error) => new AgentControlError({ detail: error.message })),
      ),
  };
});
