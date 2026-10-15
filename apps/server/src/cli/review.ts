import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

import { runReviewCliMain } from "../reviewCli/ReviewCli.ts";

/**
 * Hosts the `viewcode-review` CLI inside the executable. The shim passes the
 * agent's arguments after `--` so the CLI parser leaves its flags alone.
 */
export const viewcodeReviewCommand = Command.make("__viewcode-review", {
  args: Argument.String("args").pipe(Argument.variadic),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ args }) =>
    Effect.promise(() => runReviewCliMain(args.map(String))).pipe(
      Effect.flatMap((code) => Effect.sync(() => void (process.exitCode = code))),
    ),
  ),
);
