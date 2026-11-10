import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { stageComputerDriver } from "./viewcode-computer-driver.ts";

type Spawned = { readonly command: string; readonly args: ReadonlyArray<string> };

const exited = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

/** Stands in for cargo and lipo: records each command and lets the test write its output. */
const spawner = (onSpawn: (spawned: Spawned) => Effect.Effect<number>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      onSpawn(command as unknown as Spawned).pipe(Effect.map(exited)),
    ),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-computer-driver-" });
  const stageResourcesDir = path.join(repoRoot, "stage");
  const built = (target: string) =>
    path.join(
      repoRoot,
      "native/computer-driver/target",
      target,
      "release/viewcode-computer-driver",
    );
  const writeBuilt = (target: string, content: string) =>
    fs
      .makeDirectory(path.dirname(built(target)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(built(target), content)), Effect.orDie);
  return {
    fs,
    repoRoot,
    stageResourcesDir,
    writeBuilt,
    staged: path.join(stageResourcesDir, "computer-driver/viewcode-computer-driver"),
    directory: path.join(stageResourcesDir, "computer-driver"),
  };
});

it.layer(NodeServices.layer)("stageComputerDriver", (it) => {
  it.effect("builds one target with cargo and stages an executable helper", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, repoRoot, stageResourcesDir, writeBuilt, staged } = yield* fixture;
        const commands: Array<Spawned> = [];
        const result = yield* stageComputerDriver({
          repoRoot,
          stageResourcesDir,
          rustTargets: ["aarch64-apple-darwin"],
        }).pipe(
          Effect.provide(
            spawner((spawned) => {
              commands.push(spawned);
              return writeBuilt("aarch64-apple-darwin", "arm helper").pipe(Effect.as(0));
            }),
          ),
        );
        assert.isTrue(result);
        assert.strictEqual(yield* fs.readFileString(staged), "arm helper");
        assert.strictEqual((yield* fs.stat(staged)).mode & 0o111, 0o111);
        assert.deepStrictEqual(
          commands.map(({ command }) => command),
          ["cargo"],
        );
        assert.includeMembers(
          [...commands[0]!.args],
          ["--locked", "--release", "--target", "aarch64-apple-darwin"],
        );
      }),
    ),
  );

  it.effect("joins two targets into one universal helper with lipo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, repoRoot, stageResourcesDir, writeBuilt, staged } = yield* fixture;
        const result = yield* stageComputerDriver({
          repoRoot,
          stageResourcesDir,
          rustTargets: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
        }).pipe(
          Effect.provide(
            spawner(({ command, args }) => {
              if (command === "lipo") {
                return fs
                  .writeFileString(args.at(-1)!, "universal")
                  .pipe(Effect.orDie, Effect.as(0));
              }
              return writeBuilt(args.at(-1)!, "thin").pipe(Effect.as(0));
            }),
          ),
        );
        assert.isTrue(result);
        assert.strictEqual(yield* fs.readFileString(staged), "universal");
      }),
    ),
  );

  it.effect("a helper that fails to build leaves an empty folder instead of failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, repoRoot, stageResourcesDir, directory, staged } = yield* fixture;
        const result = yield* stageComputerDriver({
          repoRoot,
          stageResourcesDir,
          rustTargets: ["aarch64-apple-darwin"],
        }).pipe(Effect.provide(spawner(() => Effect.succeed(101))));
        assert.isFalse(result);
        assert.isTrue(yield* fs.exists(directory));
        assert.isFalse(yield* fs.exists(staged));
      }),
    ),
  );

  it.effect("a missing cargo is not fatal either", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, repoRoot, stageResourcesDir, directory, staged } = yield* fixture;
        const result = yield* stageComputerDriver({
          repoRoot,
          stageResourcesDir,
          rustTargets: ["aarch64-apple-darwin"],
        }).pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    description: "spawn cargo ENOENT",
                  }),
                ),
              ),
            ),
          ),
        );
        assert.isFalse(result);
        assert.isTrue(yield* fs.exists(directory));
        assert.isFalse(yield* fs.exists(staged));
      }),
    ),
  );
});
