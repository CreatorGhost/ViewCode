/**
 * Commit messages, PR text, branch names and thread titles from an ACP agent
 * that needs nothing beyond the protocol (Droid, Devin): one short-lived
 * session per request, the reply's text decoded as JSON.
 *
 * @module AcpTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as EffectAcpErrors from "effect-acp/errors";

import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const ACP_TEXT_GENERATION_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

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
  const fail = (operation: Operation, detail: string, cause?: unknown) =>
    new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const { operation } = input;
      const outputRef = yield* Ref.make("");
      const runtime = yield* agent.makeRuntime(input.cwd);
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        return content.type === "text"
          ? Ref.update(outputRef, (current) => current + content.text)
          : Effect.void;
      });
      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* agent.configure(runtime, input.modelSelection);
        return yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
      }).pipe(
        Effect.timeoutOption(ACP_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(fail(operation, `${agent.label} request timed out.`)),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : fail(operation, `${agent.label} request failed.`, cause),
        ),
      );
      const output = (yield* Ref.get(outputRef)).trim();
      if (!output) {
        return yield* fail(
          operation,
          promptResult.stopReason === "cancelled"
            ? `${agent.label} request was cancelled.`
            : `${agent.label} returned empty output.`,
        );
      }
      // Each operation has its own output schema, so the decoder is built per call.
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              fail(operation, `${agent.label} returned invalid structured output.`, cause),
            ),
        }),
      );
    }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : fail(input.operation, `${agent.label} text generation failed.`, cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AcpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AcpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AcpTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AcpTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
