// @effect-diagnostics nodeBuiltinImport:off - checks the file the recorder writes synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fatalLogPath, recordFatalCause, recordFatalErrors } from "./fatalLog.ts";

/** What Node does with an uncaught exception before its own handling. */
const crash = (error: Error) => {
  for (const listener of process.listeners("uncaughtExceptionMonitor")) {
    listener(error, "uncaughtException");
  }
};

const tempLogsDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fatal-log-"));

it.effect("records an uncaught exception synchronously while the server runs", () =>
  Effect.gen(function* () {
    const logsDir = tempLogsDir();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* recordFatalErrors(logsDir);
        crash(new Error("ingestion blew up"));
      }),
    );
    // The listener is gone once the server's scope closes.
    crash(new Error("after shutdown"));

    const log = NodeFS.readFileSync(fatalLogPath(logsDir), "utf8");
    expect(log).toContain("uncaughtException");
    expect(log).toContain("Error: ingestion blew up");
    expect(log).toContain("fatalLog.test.ts");
    expect(log).not.toContain("after shutdown");
  }),
);

it.effect("records the server's own failure but not an interruption", () =>
  Effect.gen(function* () {
    const logsDir = tempLogsDir();
    yield* Effect.interrupt.pipe(recordFatalCause(logsDir), Effect.exit);
    expect(NodeFS.existsSync(fatalLogPath(logsDir))).toBe(false);

    yield* Effect.die(new Error("engine died")).pipe(recordFatalCause(logsDir), Effect.exit);
    const log = NodeFS.readFileSync(fatalLogPath(logsDir), "utf8");
    expect(log).toContain("server failed");
    expect(log).toContain("engine died");
  }),
);
