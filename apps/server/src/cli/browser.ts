import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

import { runBrowserCliMain } from "../browserCli/BrowserCli.ts";

/**
 * Hosts the `viewcode-browser` CLI inside the executable. The shim passes the
 * agent's arguments after `--` so the CLI parser leaves its flags alone.
 */
export const viewcodeBrowserCommand = Command.make("__viewcode-browser", {
  args: Argument.String("args").pipe(Argument.variadic),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ args }) =>
    Effect.promise(() => runBrowserCliMain(args.map(String))).pipe(
      Effect.flatMap((code) => Effect.sync(() => void (process.exitCode = code))),
    ),
  ),
);
