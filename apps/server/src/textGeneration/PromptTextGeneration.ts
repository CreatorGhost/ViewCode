/**
 * Commit messages, PR text, branch names and thread titles on top of one
 * "send a prompt, get the reply text" call, for agents whose text generation
 * is just a short-lived session (Droid, Devin, Pi). The reply is decoded as
 * the operation's JSON.
 *
 * @module PromptTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type * as TextGeneration from "./TextGeneration.ts";
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

export type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface TextPromptRun {
  readonly operation: TextGenerationOperation;
  readonly cwd: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}

export const isTextGenerationError = Schema.is(TextGenerationError);

export function makePromptTextGeneration(
  /** Product name used in error messages. */
  label: string,
  runPrompt: (run: TextPromptRun) => Effect.Effect<string, TextGenerationError>,
): TextGeneration.TextGeneration["Service"] {
  const runJson = <S extends Schema.Top>(
    run: TextPromptRun & { readonly outputSchemaJson: S },
  ): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const output = (yield* runPrompt(run)).trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: run.operation,
          detail: `${label} returned empty output.`,
        });
      }
      // Each operation has its own output schema, so the decoder is built per call.
      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(run.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: run.operation,
                detail: `${label} returned invalid structured output.`,
                cause,
              }),
            ),
        }),
      );
    });

  return {
    generateCommitMessage: Effect.fn("PromptTextGeneration.generateCommitMessage")(
      function* (input) {
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
      },
    ),
    generatePrContent: Effect.fn("PromptTextGeneration.generatePrContent")(function* (input) {
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
    }),
    generateBranchName: Effect.fn("PromptTextGeneration.generateBranchName")(function* (input) {
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
    }),
    generateThreadTitle: Effect.fn("PromptTextGeneration.generateThreadTitle")(function* (input) {
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
    }),
  };
}
