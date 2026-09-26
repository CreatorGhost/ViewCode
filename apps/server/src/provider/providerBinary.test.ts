// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkClaudeProviderStatus } from "./Layers/ClaudeProvider.ts";
import { guardMissingProviderBinary } from "./providerBinary.ts";

const encoder = new TextEncoder();
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
// The stubs are `#!/bin/sh` scripts.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

function recordingSpawner(stdout: string) {
  const spawned: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      spawned.push(command._tag === "StandardCommand" ? command.command : "<piped>");
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawned };
}

const guarded = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return guardMissingProviderBinary(spawner, fileSystem, path);
  });

const makeExecutable = (name: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-binary-"));
  const file = NodePath.join(dir, name);
  NodeFS.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(file, 0o755);
  return { dir, file };
};

describe("guardMissingProviderBinary", () => {
  it.effect("fails like ENOENT and never spawns a command missing from PATH", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner("");
      const guard = yield* guarded(spawner);
      const emptyDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-empty-"));
      const error = yield* Effect.flip(
        Effect.scoped(
          guard.spawn(
            ChildProcess.make("t3-missing-provider-cli", ["--version"], {
              env: { PATH: emptyDir },
            }),
          ),
        ),
      );
      assert.strictEqual(error.reason._tag, "NotFound");
      assert.deepStrictEqual(spawned, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails for a configured absolute path that does not exist", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner("");
      const guard = yield* guarded(spawner);
      const missing = NodePath.join(NodeOS.tmpdir(), "t3-no-such-dir", "codex");
      const error = yield* Effect.flip(
        Effect.scoped(guard.spawn(ChildProcess.make(missing, ["app-server"]))),
      );
      assert.strictEqual(error.reason._tag, "NotFound");
      assert.deepStrictEqual(spawned, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("spawns a command that resolves on PATH or by absolute path", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner("");
      const guard = yield* guarded(spawner);
      const { dir, file } = makeExecutable("t3-present-provider-cli");
      yield* Effect.scoped(
        guard.spawn(
          ChildProcess.make("t3-present-provider-cli", ["--version"], { env: { PATH: dir } }),
        ),
      );
      yield* Effect.scoped(guard.spawn(ChildProcess.make(file, ["--version"])));
      assert.deepStrictEqual(spawned, ["t3-present-provider-cli", file]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("makes a provider check report not installed without spawning", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner("1.0.0\n");
      const guard = yield* guarded(spawner);
      const settings = decodeClaudeSettings({
        binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-no-such-dir", "claude"),
      });
      const status = yield* checkClaudeProviderStatus(settings, () =>
        Effect.sync(() => undefined),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guard));
      assert.strictEqual(status.installed, false);
      assert.strictEqual(status.status, "error");
      assert.deepStrictEqual(spawned, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
