import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { browserCommand, setupBaseDir } from "./browser.ts";

it.effect("installs browser tools into the invoking user's ViewCode home under sudo", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    const resolved = yield* setupBaseDir(Option.none()).pipe(
      Effect.provide(
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
          string: (command) => {
            assert.isTrue(ChildProcess.isStandardCommand(command));
            if (ChildProcess.isStandardCommand(command))
              commands.push([command.command, ...command.args]);
            return Effect.succeed("developer:x:1000:1000::/home/developer:/bin/bash\n");
          },
        }),
      ),
    );
    assert.equal(resolved, "/home/developer/.viewcode");
    assert.deepEqual(commands, [["getent", "passwd", "developer"]]);
  }).pipe(
    Effect.provideService(HostProcess.Environment, { SUDO_USER: "developer" }),
    Effect.provideService(HostProcess.HomeDirectory, "/root"),
    Effect.provide(Path.layer),
  ),
);

it.effect("honors an explicit home and avoids user lookup even under sudo", () =>
  Effect.gen(function* () {
    const noSpawner = ChildProcessSpawner.make(() =>
      Effect.die("Explicit homes must not start getent"),
    );
    assert.equal(
      yield* setupBaseDir(Option.some("/isolated/copy")).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      ),
      "/isolated/copy",
    );
    assert.equal(
      yield* setupBaseDir(Option.none()).pipe(
        Effect.provideService(HostProcess.Environment, {
          SUDO_USER: "developer",
          T3CODE_HOME: "/isolated/environment-copy",
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      ),
      "/isolated/environment-copy",
    );
  }).pipe(
    Effect.provideService(HostProcess.Environment, { SUDO_USER: "developer" }),
    Effect.provide(Path.layer),
  ),
);

it.effect("setup in a root shell warns that the server cannot run as root", () =>
  Effect.gen(function* () {
    // Every file read fails, so setup finds nothing to install and changes nothing.
    yield* Command.runWith(browserCommand, { version: "0.0.0" })([
      "setup",
      "--base-dir",
      "/nonexistent",
    ]).pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      // A root user who follows the old advice runs setup through sudo.
      Effect.provideService(HostProcess.Environment, { SUDO_USER: "root" }),
    );
    const output = (yield* TestConsole.logLines).join("\n");
    expect(output).toContain("Chrome will not start its sandbox as root");
    expect(output).not.toContain("ready");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);
