// @effect-diagnostics nodeBuiltinImport:off globalDate:off - written synchronously while the process is dying, when no fiber will run the FileSystem service or the clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Where a dying server leaves its last error. The logger writes to stdout and
 * stderr asynchronously, and under a parent that pipes them (`vp run dev`, the
 * desktop app) whatever is still queued is dropped when the process exits, so
 * the error that killed it is exactly what never arrives. This file is written
 * synchronously instead.
 */
export const fatalLogPath = (logsDir: string): string => NodePath.join(logsDir, "server-fatal.log");

const appendFatal = (path: string, origin: string, error: unknown): void => {
  try {
    const detail = typeof error === "string" ? error : NodeUtil.inspect(error, { depth: 8 });
    NodeFS.appendFileSync(
      path,
      `[${new Date().toISOString()}] ${origin} (pid ${process.pid})\n${detail}\n\n`,
    );
  } catch {
    // Recording must never be what fails while the process is going down.
  }
};

/**
 * Records uncaught exceptions and unhandled rejections for the scope's life.
 * The monitor event leaves Node's own handling, including the exit, unchanged.
 */
export const recordFatalErrors = (logsDir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const path = fatalLogPath(logsDir);
      const monitor = (error: unknown, origin: string) => appendFatal(path, origin, error);
      process.on("uncaughtExceptionMonitor", monitor);
      return monitor;
    }),
    (monitor) => Effect.sync(() => process.off("uncaughtExceptionMonitor", monitor)),
  );

/** Records the server's own failure before the runtime exits the process. */
export const recordFatalCause =
  (logsDir: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() =>
              appendFatal(fatalLogPath(logsDir), "server failed", Cause.pretty(cause)),
            ),
      ),
    );
