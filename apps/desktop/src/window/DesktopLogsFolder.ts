/**
 * ViewCode: open the environment's logs folder from the desktop menu.
 *
 * Runs in the main process only, so it works while the backend is down: the
 * folder holds server-child.log and the spawn trace that explain a crash.
 * The backend creates the folder on its first start.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import * as Electron from "electron";

export class OpenLogsFolderError extends Data.TaggedError("OpenLogsFolderError")<{
  readonly logDir: string;
  readonly cause: unknown;
}> {}

export const openLogsFolder = Effect.fn("desktop.openLogsFolder")(function* (logDir: string) {
  const failure = yield* Effect.promise(() => Electron.shell.openPath(logDir));
  if (failure) return yield* new OpenLogsFolderError({ logDir, cause: failure });
});
