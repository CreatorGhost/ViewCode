/**
 * Stdio JSONL transport for `pi --mode rpc` (adapted from upstream T3 Code's
 * `packages/provider-pi/src/server/rpc.ts`).
 *
 * Requests go to stdin with an `id`; the `response` record with that id
 * settles them. Every other stdout record is a session event, delivered on
 * `events` in arrival order. Lines are split on LF only (never `readline`,
 * which also splits on U+2028/U+2029 inside JSON strings), and a record that
 * is not JSON is dropped rather than failing the transport.
 *
 * @module piRpcConnection
 */
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { PiRecord } from "./piRpc.ts";

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export interface PiRpcConnection {
  /** Writes a record without waiting for an answer (`extension_ui_response`). */
  readonly send: (record: PiRecord) => Effect.Effect<void, PiRpcError>;
  /** Sends a command and waits for its response's `data`; fails on `success: false`. */
  readonly request: (record: PiRecord, timeoutMs?: number) => Effect.Effect<unknown, PiRpcError>;
  /** Session events in arrival order; fails once the process is gone. */
  readonly events: Queue.Dequeue<PiRecord, PiRpcError>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ERROR_DETAIL_MAX_CHARS = 300;
const UnknownFromJson = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeUnknownOption(UnknownFromJson);
const encodeJsonLine = Schema.encodeSync(UnknownFromJson);

function summarize(error: unknown): string {
  const text = typeof error === "string" ? error : (encodeJsonLine(error) ?? "unknown error");
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

/** Splits stdout chunks into LF-terminated lines, dropping a trailing `\r`. */
export function makePiLineSplitter() {
  let buffer = "";
  return (chunk: string): ReadonlyArray<string> => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0);
  };
}

/** Spawns Pi in RPC mode for the life of the current scope. */
export const makePiRpcConnection = Effect.fn("makePiRpcConnection")(function* (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const spawnCommand = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new PiRpcError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(Effect.mapError((cause) => new PiRpcError({ operation: "spawn", cause })));

  const pending = new Map<string, Deferred.Deferred<unknown, PiRpcError>>();
  const events = yield* Queue.unbounded<PiRecord, PiRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, PiRpcError>();
  const down = yield* Deferred.make<never, PiRpcError>();
  let nextId = 0;

  const failTransport = (error: PiRpcError) =>
    Effect.gen(function* () {
      if (!(yield* Deferred.fail(down, error))) return;
      for (const [id, deferred] of pending) {
        pending.delete(id);
        yield* Deferred.fail(deferred, error);
      }
      yield* Queue.fail(outgoing, error);
      yield* Queue.fail(events, error);
    });

  const route = (record: PiRecord) =>
    Effect.gen(function* () {
      const id = record.id;
      if (record.type === "response" && typeof id === "string" && pending.has(id)) {
        const deferred = pending.get(id)!;
        pending.delete(id);
        if (record.success === true) {
          yield* Deferred.succeed(deferred, record.data);
        } else {
          yield* Deferred.fail(
            deferred,
            new PiRpcError({
              operation: String(record.command ?? "request"),
              detail: summarize(record.error),
            }),
          );
        }
        return;
      }
      yield* Queue.offer(events, record);
    });

  const split = makePiLineSplitter();
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.forEach(
        split(chunk),
        (line) => {
          const parsed = decodeJsonLine(line);
          return parsed._tag === "Some" &&
            typeof parsed.value === "object" &&
            parsed.value !== null &&
            !Array.isArray(parsed.value)
            ? route(parsed.value as PiRecord)
            : Effect.logDebug("Dropping a non-JSON Pi stdout line.", { length: line.length });
        },
        { discard: true },
      ),
    ),
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new PiRpcError({ operation: "read", cause })),
      onSuccess: () =>
        child.exitCode.pipe(
          Effect.timeoutOption(Duration.millis(250)),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((code) =>
            failTransport(
              new PiRpcError({
                operation: "read",
                detail:
                  code && code._tag === "Some"
                    ? `pi exited with code ${Number(code.value)}`
                    : "pi closed stdout",
              }),
            ),
          ),
        ),
    }),
    Effect.forkIn(scope),
  );
  // Pi keeps stdout for the protocol; stderr can carry prompts or credentials,
  // so only its size is logged.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.logDebug("pi stderr", { length: chunk.length })),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => failTransport(new PiRpcError({ operation: "write", cause }))),
    Effect.forkIn(scope),
  );
  yield* Scope.addFinalizer(
    scope,
    failTransport(new PiRpcError({ operation: "close", detail: "pi was stopped" })),
  );

  const send = (record: PiRecord): Effect.Effect<void, PiRpcError> =>
    Effect.gen(function* () {
      const line = new TextEncoder().encode(`${encodeJsonLine(record)}\n`);
      if (!(yield* Queue.offer(outgoing, line))) return yield* Deferred.await(down);
    });

  const request = (record: PiRecord, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) =>
    Effect.suspend(() => {
      const id = `vc-${nextId++}`;
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, PiRpcError>();
        pending.set(id, deferred);
        yield* send({ ...record, id });
        return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(down)).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () =>
              Effect.fail(
                new PiRpcError({
                  operation: String(record.type ?? "request"),
                  detail: `timed out after ${timeoutMs}ms`,
                }),
              ),
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    });

  return { send, request, events } satisfies PiRpcConnection;
});
