import { type CommandCodeSettings, TextGenerationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { buildCommandCodeTurnArgs, resolveCommandCodeBinary } from "./commandCodeProtocol.ts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
const COMMAND_CODE_TIMEOUT_MS = 180_000;

const ResultLine = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  finalText: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
const decodeResultLine = Schema.decodeUnknownOption(Schema.fromJsonString(ResultLine));

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binary = resolveCommandCodeBinary(settings.binaryPath, yield* HostProcess.Platform);

  const runJson: TextGenerationOperations.Runner = (input) =>
    Effect.gen(function* () {
      const { operation } = input;
      const args = [
        ...buildCommandCodeTurnArgs({ model: input.modelSelection.model, fullAccess: false }),
        "--no-session",
      ];
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: environment,
          shell: spawnCommand.shell,
          stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
        }),
      );
      const [stdout, stderr] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const result = stdout
        .split(/\r?\n/)
        .map((line) => decodeResultLine(line.trim()))
        .findLast(Option.isSome);
      if (!result || result.value.subtype === "error") {
        const detail = result?.value.error?.trim() || stderr.trim() || "it printed no result line";
        return yield* new TextGenerationError({
          operation,
          detail: `Command Code CLI command failed: ${detail}`,
        });
      }
      const text = result.value.finalText?.trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "Command Code returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(input, "Command Code", text);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(COMMAND_CODE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Command Code CLI request timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        normalizeCliError(binary, input.operation, cause, "Command Code CLI request failed"),
      ),
    );

  return TextGenerationOperations.fromRunner(
    "Command Code",
    TextGenerationOperations.withoutInvestigation("Command Code", runJson),
  );
});
