/**
 * The server's own process ancestry: this process, its parent, and further
 * ancestors up to init/launchd. The desktop app's windows belong to its main
 * process, which spawned the server, so a window owned by any of these pids
 * is ViewCode (or the terminal hosting it) whatever its name says.
 *
 * Read once at startup with `ps` on macOS and Linux; best effort. Elsewhere
 * it is the process and its parent only.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const MAX_DEPTH = 32;

export class ServerProcessAncestry extends Context.Service<
  ServerProcessAncestry,
  ReadonlySet<number>
>()("t3/computerUse/computerUseAncestry/ServerProcessAncestry") {}

export const readServerProcessAncestry = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const pids = new Set<number>([process.pid]);
  if (process.ppid > 1) pids.add(process.ppid);
  if (platform !== "darwin" && platform !== "linux") return pids;
  let current = process.ppid;
  for (let depth = 0; depth < MAX_DEPTH && current > 1; depth += 1) {
    const result = yield* runner
      .run({
        command: "ps",
        args: ["-o", "ppid=", "-p", String(current)],
        timeout: Duration.seconds(2),
      })
      .pipe(Effect.option);
    const parent =
      result._tag === "Some" && result.value.code === 0
        ? Number.parseInt(result.value.stdout.trim(), 10)
        : Number.NaN;
    if (!Number.isInteger(parent) || parent <= 1 || pids.has(parent)) break;
    pids.add(parent);
    current = parent;
  }
  return pids;
});

export const layer = Layer.effect(ServerProcessAncestry, readServerProcessAncestry);
