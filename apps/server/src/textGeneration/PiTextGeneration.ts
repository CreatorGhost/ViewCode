/**
 * Text generation from Pi: a throwaway `pi --mode rpc --no-session` run with
 * no tools, skills or project context, whose final assistant text is the reply.
 *
 * @module PiTextGeneration
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { PI_DEFAULT_MODEL, type PiSettings, TextGenerationError } from "@t3tools/contracts";

import {
  parsePiModelSlug,
  piContentText,
  piField,
  PI_THINKING_OPTION_ID,
} from "../provider/piRpc.ts";
import { makePiRpcConnection } from "../provider/piRpcConnection.ts";
import { isTextGenerationError, makePromptTextGeneration } from "./PromptTextGeneration.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return makePromptTextGeneration("Pi", (run) =>
    Effect.gen(function* () {
      const connection = yield* makePiRpcConnection({
        command: settings.binaryPath.trim() || "pi",
        args: [
          "--mode",
          "rpc",
          "--no-session",
          "--offline",
          "--no-tools",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ],
        cwd: run.cwd,
        env: environment,
      });
      const reply = yield* Ref.make("");
      const settled = yield* Deferred.make<void, TextGenerationError>();
      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((record) => {
          const message = piField(record, "message");
          if (record.type === "message_end" && piField(message, "role") === "assistant") {
            return Ref.set(reply, piContentText(piField(message, "content")));
          }
          return record.type === "agent_settled"
            ? Deferred.succeed(settled, undefined)
            : Effect.void;
        }),
        Effect.ignore,
        // Events end when Pi does; settling first makes this a no-op.
        Effect.andThen(
          Deferred.fail(
            settled,
            new TextGenerationError({
              operation: run.operation,
              detail: "Pi stopped before it answered.",
            }),
          ),
        ),
        Effect.forkScoped,
      );
      const model = parsePiModelSlug(run.modelSelection.model);
      if (run.modelSelection.model !== PI_DEFAULT_MODEL && model) {
        yield* connection.request({ type: "set_model", ...model });
      }
      const thinking = run.modelSelection.options?.find(
        (option) => option.id === PI_THINKING_OPTION_ID,
      )?.value;
      if (typeof thinking === "string" && thinking) {
        yield* connection.request({ type: "set_thinking_level", level: thinking });
      }
      yield* connection.request({ type: "prompt", message: run.prompt });
      yield* Deferred.await(settled);
      return yield* Ref.get(reply);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeoutOption(PI_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: run.operation,
                detail: "Pi request timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: run.operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
    ),
  );
});
