import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

// ViewCode guard: the backend's stdout/stderr reach server-child.log while it
// runs. Upstream only wrote that file after a crash, so a merge that restores
// that behaviour, or stops piping the backend's output, fails here.

const BackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  annotations: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(BackendChildLogRecord));

const readRecords = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.map((text) =>
      text
        .trimEnd()
        .split("\n")
        .map((line) => decodeRecord(line)),
    ),
  );

const layerEnvironmentFor = (baseDir: string) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

const layerHealthyHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

// A developer's own OTEL_* variables would otherwise pick export endpoints.
const layerEmptyEnv = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "viewcode-backend-output-",
  });
  const layerEnvironment = layerEnvironmentFor(baseDir);
  const logDir = yield* Effect.gen(function* () {
    return (yield* DesktopEnvironment.DesktopEnvironment).logDir;
  }).pipe(Effect.provide(layerEnvironment));
  const layerObservability = DesktopObservability.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provide(layerHealthyHttpClient),
  );
  return { fileSystem, baseDir, logDir, layerObservability };
});

const encode = (text: string) => new TextEncoder().encode(text);

describe("DesktopObservability (ViewCode)", () => {
  it.effect("writes a running backend's output to server-child.log as it arrives", () =>
    Effect.gen(function* () {
      const { fileSystem, baseDir, logDir, layerObservability } = yield* setup;
      const entryPath = `${baseDir}/bin.mjs`;
      yield* fileSystem.writeFileString(entryPath, "");

      let spawned: ChildProcess.Command | undefined;
      const stdoutDrained = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawned = command;
            // The real spawner kills the process when the run's scope closes.
            yield* Effect.addFinalizer(() => Deferred.succeed(killed, undefined));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(4242),
              // The drain pulls the next element only after the sink took the
              // chunk, so `stdoutDrained` completes once the write is done. The
              // stream then stays open, like a live process's, until it is killed.
              stdout: Stream.make(encode("Quick connect WebSocket message too big\n")).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.succeed(stdoutDrained, undefined))),
                Stream.concat(Stream.fromEffectDrain(Deferred.await(killed))),
              ),
              stderr: Stream.make(encode("a warning on stderr\n")),
              all: Stream.empty,
              exitCode: Deferred.await(killed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Effect.succeed(true),
              kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const instance = yield* DesktopBackendManager.makeBackendInstance({
          id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
          label: Effect.succeed("Local"),
          configResolve: Effect.succeed({
            executablePath: "/t3-server/t3",
            args: ["--bootstrap-fd", "3"],
            entryPath,
            cwd: baseDir,
            env: {},
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port: 3773,
              t3Home: baseDir,
              host: "127.0.0.1",
              desktopBootstrapToken: "token",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
            bootstrapDelivery: "fd3",
            extendEnv: true,
            httpBaseUrl: new URL("http://127.0.0.1:3773"),
            captureOutput: true,
            preflightFailure: Option.none(),
          }),
        });
        yield* instance.start;
        yield* Deferred.await(stdoutDrained);

        if (spawned?._tag !== "StandardCommand") {
          return assert.fail("expected the backend to be spawned");
        }
        assert.equal(spawned.options.stdout, "pipe");
        assert.equal(spawned.options.stderr, "pipe");

        // Still running: nothing has failed or stopped yet.
        const whileRunning = yield* readRecords(fileSystem, `${logDir}/server-child.log`);
        assert.equal(whileRunning[0]?.message, "backend child process started");
        assert.isTrue(
          whileRunning.some(
            (record) =>
              record.annotations.stream === "stdout" &&
              record.annotations.text === "Quick connect WebSocket message too big\n",
          ),
        );
        assert.isFalse(whileRunning.some((record) => record.annotations.phase === "END"));

        yield* instance.stop();
        const afterStop = yield* readRecords(fileSystem, `${logDir}/server-child.log`);
        assert.equal(afterStop.at(-1)?.message, "backend child process stopped");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerObservability,
            layerSpawner,
            layerHealthyHttpClient,
            Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
              latest: Effect.succeedNone,
              changes: Stream.empty,
              encoded: Stream.empty,
              handleControlForSource: () => Effect.void,
              removeControlSource: () => Effect.void,
              publishUpdateReport: () => Effect.void,
              updateRequests: Stream.empty,
              updateCommits: Stream.empty,
              updateCancellations: Stream.empty,
            }),
            DesktopBrowserHost.layer,
            DesktopWslEnvironment.layerTest(),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, layerEmptyEnv))),
  );

  it.effect(
    "marks failures without repeating output, and gives other instances their own file",
    () =>
      Effect.gen(function* () {
        const { fileSystem, logDir, layerObservability } = yield* setup;

        yield* Effect.gen(function* () {
          const factory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
          const outputLog = yield* factory.forInstance("wsl:Ubuntu");
          yield* outputLog.beginSession({ details: "pid=7" });
          // "é" split across two chunks still decodes as one character.
          yield* outputLog.writeOutputChunk("stderr", Uint8Array.of(0x63, 0x61, 0x66, 0xc3));
          yield* outputLog.writeOutputChunk("stderr", Uint8Array.of(0xa9, 0x0a));
          yield* outputLog.persistFailureSnapshot({ details: "readiness timeout" });
          yield* outputLog.persistFailure({ details: "code=1" });
          yield* outputLog.discardSession;
        }).pipe(Effect.provide(layerObservability));

        assert.isFalse(yield* fileSystem.exists(`${logDir}/server-child.log`));
        const records = yield* readRecords(fileSystem, `${logDir}/server-child-wsl_Ubuntu.log`);
        assert.deepEqual(
          records.map((record) => [record.message, record.annotations.phase ?? null]),
          [
            ["backend child process started", "START"],
            ["backend child process output", null],
            ["backend child process output", null],
            ["backend child process failure", "FAILURE"],
            ["backend child process failure", "END"],
          ],
        );
        assert.equal(
          records
            .filter((record) => record.annotations.stream === "stderr")
            .map((record) => record.annotations.text)
            .join(""),
          "café\n",
        );
        assert.equal(records.at(-1)?.annotations.details, "code=1");

        // Per-chunk writes must not each become a span in desktop.trace.ndjson.
        const traces = yield* fileSystem.readFileString(`${logDir}/desktop.trace.ndjson`);
        assert.isTrue(traces.includes("desktop.observability.backendOutput.beginSession"));
        assert.isFalse(traces.includes("writeOutputChunk"));
        assert.isFalse(traces.includes("writeBackendChildLogRecord"));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, layerEmptyEnv))),
  );
});
