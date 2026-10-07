import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

import { runComputerCliMain } from "../computerUse/ComputerUseCli.ts";
import { runComputerUseDriverWorker } from "../computerUse/Xa11yDriverWorker.ts";

/**
 * Hosts the computer-use driver process inside the CLI executable, which has
 * no Node to run the sibling `computer-use-driver.mjs` script with.
 */
export const computerUseDriverCommand = Command.make("__computer-use-driver", {}).pipe(
  Command.unlisted,
  Command.withHandler(() => Effect.promise(runComputerUseDriverWorker)),
);

/**
 * Hosts the `viewcode-computer` CLI inside the executable. The shim passes the
 * agent's arguments after `--` so the CLI parser leaves its flags alone.
 */
export const viewcodeComputerCommand = Command.make("__viewcode-computer", {
  args: Argument.String("args").pipe(Argument.variadic),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ args }) =>
    Effect.promise(() => runComputerCliMain(args.map(String))).pipe(
      Effect.flatMap((code) => Effect.sync(() => void (process.exitCode = code))),
    ),
  ),
);
