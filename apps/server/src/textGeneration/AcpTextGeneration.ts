/**
 * Text generation from an ACP agent that needs nothing beyond the protocol
 * (Droid, Devin): one short-lived session per request.
 *
 * @module AcpTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type * as EffectAcpErrors from "effect-acp/errors";

import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";

import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import { isTextGenerationError, makePromptTextGeneration } from "./PromptTextGeneration.ts";

const ACP_TEXT_GENERATION_TIMEOUT_MS = 180_000;

export interface AcpTextGenerationAgent {
  /** Product name used in error messages. */
  readonly label: string;
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
  readonly configure: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    modelSelection: ModelSelection,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export const makeAcpTextGeneration = Effect.fn("makeAcpTextGeneration")(function* (
  agent: AcpTextGenerationAgent,
) {
  const crypto = yield* Crypto.Crypto;
  return makePromptTextGeneration(agent.label, (run) =>
    Effect.gen(function* () {
      const fail = (detail: string, cause?: unknown) =>
        new TextGenerationError({
          operation: run.operation,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const outputRef = yield* Ref.make("");
      const runtime = yield* agent.makeRuntime(run.cwd);
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        return content.type === "text"
          ? Ref.update(outputRef, (current) => current + content.text)
          : Effect.void;
      });
      const result = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* agent.configure(runtime, run.modelSelection);
        return yield* runtime.prompt({ prompt: [{ type: "text", text: run.prompt }] });
      }).pipe(
        Effect.timeoutOption(ACP_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(fail(`${agent.label} request timed out.`)),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause) ? cause : fail(`${agent.label} request failed.`, cause),
        ),
      );
      if (result.stopReason === "cancelled") {
        return yield* fail(`${agent.label} request was cancelled.`);
      }
      return yield* Ref.get(outputRef);
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: run.operation,
              detail: `${agent.label} text generation failed.`,
              cause,
            }),
      ),
      Effect.scoped,
    ),
  );
});
