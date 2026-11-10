/**
 * Stages `native/computer-driver` (ViewCode's agent-desktop computer-use
 * helper) into the macOS desktop app. Kept apart from
 * `build-desktop-artifact.ts`, which is upstream's, so a merge only has to
 * keep the three places that call into this file.
 *
 * The helper is opt-in at runtime and has no fallback inside the app, so a
 * helper that does not build must not fail the app build: the folder ships
 * empty and the server reports the driver as unavailable when it is selected.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The folder under the app's resources; the server looks for the helper here. */
export const COMPUTER_DRIVER_RESOURCE_DIR = "computer-driver";
export const COMPUTER_DRIVER_EXECUTABLE = "viewcode-computer-driver";

export const MAC_COMPUTER_DRIVER_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${COMPUTER_DRIVER_RESOURCE_DIR}`,
  to: COMPUTER_DRIVER_RESOURCE_DIR,
} as const;

/** The staged copies stay out of app.asar; the helper is emitted once, as a resource. */
export const MAC_COMPUTER_DRIVER_FILE_EXCLUSIONS = [
  `!apps/desktop/resources/${COMPUTER_DRIVER_RESOURCE_DIR}`,
  `!apps/desktop/resources/${COMPUTER_DRIVER_RESOURCE_DIR}/**/*`,
  `!apps/desktop/prod-resources/${COMPUTER_DRIVER_RESOURCE_DIR}`,
  `!apps/desktop/prod-resources/${COMPUTER_DRIVER_RESOURCE_DIR}/**/*`,
] as const;

const run = Effect.fn("stageComputerDriver.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
  );
  return Number(yield* child.exitCode) === 0;
});

/**
 * Builds the helper for each Rust target and puts one executable (a universal
 * one for two targets) in `<stageResourcesDir>/computer-driver`. Returns
 * whether it was staged; the folder exists either way, so electron-builder's
 * resource entry always has a source.
 */
export const stageComputerDriver = Effect.fn("stageComputerDriver")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly rustTargets: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destinationDirectory = path.join(input.stageResourcesDir, COMPUTER_DRIVER_RESOURCE_DIR);
  const destinationPath = path.join(destinationDirectory, COMPUTER_DRIVER_EXECUTABLE);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  const manifestPath = path.join(input.repoRoot, "native/computer-driver/Cargo.toml");
  const stage = Effect.gen(function* () {
    const built: Array<string> = [];
    for (const rustTarget of input.rustTargets) {
      const ok = yield* run(
        "cargo",
        ["build", "--locked", "--release", "--manifest-path", manifestPath, "--target", rustTarget],
        input.repoRoot,
      );
      const binaryPath = path.join(
        input.repoRoot,
        "native/computer-driver/target",
        rustTarget,
        "release",
        COMPUTER_DRIVER_EXECUTABLE,
      );
      if (!ok || !(yield* fs.exists(binaryPath))) return false;
      built.push(binaryPath);
    }
    if (built.length === 0) return false;
    if (built.length === 1) {
      yield* fs.copyFile(built[0]!, destinationPath);
    } else if (
      !(yield* run("lipo", ["-create", ...built, "-output", destinationPath], input.repoRoot))
    ) {
      return false;
    }
    yield* fs.chmod(destinationPath, 0o755);
    return true;
  });

  const staged = yield* stage.pipe(Effect.orElseSucceed(() => false));
  if (!staged) {
    // A half-written universal binary must not ship.
    yield* fs.remove(destinationPath, { force: true }).pipe(Effect.ignore);
    yield* Effect.logWarning(
      "[desktop-artifact] The agent-desktop computer-use helper did not build, so this app ships without it. Computer use keeps its default driver; VIEWCODE_COMPUTER_DRIVER=agent-desktop will report the driver as unavailable.",
    );
  }
  return staged;
});
