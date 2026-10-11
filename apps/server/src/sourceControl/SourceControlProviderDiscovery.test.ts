import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type VcsError, VcsProcessTimeoutError } from "@t3tools/contracts";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import { makeSourceControlDiscoveryProbes } from "./SourceControlProviderDiscovery.ts";

const output: VcsProcess.VcsProcessOutput = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: '{"hosts":{}}',
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

/** A process double that records each spawn's cwd and answers with `respond`. */
function recordingProcess(
  respond: (
    input: VcsProcess.VcsProcessInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>,
) {
  const spawns: Array<string> = [];
  const process = {
    run: (input: VcsProcess.VcsProcessInput) =>
      Effect.suspend(() => {
        spawns.push(input.cwd);
        return respond(input);
      }),
  } satisfies VcsProcess.VcsProcess["Service"];
  return { spawns, process };
}

const gh = GitHubSourceControlProvider.discovery;

it.effect("concurrent callers in different repositories share one gh auth probe", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const { spawns, process } = recordingProcess(() =>
      Deferred.await(release).pipe(Effect.as(output)),
    );
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    const callers = yield* Effect.forEach(["/repo/a", "/repo/b", "/repo/c"], (cwd) =>
      Effect.forkChild(probes.refineUnknownRemote(gh, cwd), { startImmediately: true }),
    );
    yield* Deferred.succeed(release, undefined);
    const results = yield* Fiber.joinAll(callers);

    assert.deepStrictEqual(spawns, ["/repo/a"]);
    assert.deepStrictEqual(results, [output, output, output]);
  }),
);

it.effect("an interrupted caller does not cancel the probe other callers are waiting on", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const { spawns, process } = recordingProcess(() =>
      Deferred.await(release).pipe(Effect.as(output)),
    );
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    const first = yield* Effect.forkChild(probes.refineUnknownRemote(gh, "/repo/a"), {
      startImmediately: true,
    });
    const second = yield* Effect.forkChild(probes.refineUnknownRemote(gh, "/repo/b"), {
      startImmediately: true,
    });
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);

    assert.deepStrictEqual(yield* Fiber.join(second), output);
    assert.deepStrictEqual(yield* probes.refineUnknownRemote(gh, "/repo/c"), output);
    assert.deepStrictEqual(spawns, ["/repo/a"]);
  }),
);

it.effect("reuses a gh auth probe for a minute after success", () =>
  Effect.gen(function* () {
    const { spawns, process } = recordingProcess(() => Effect.succeed(output));
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    yield* probes.refineUnknownRemote(gh, "/repo/a");
    yield* TestClock.adjust(Duration.seconds(59));
    yield* probes.refineUnknownRemote(gh, "/repo/b");
    assert.strictEqual(spawns.length, 1);

    yield* TestClock.adjust(Duration.seconds(1));
    yield* probes.refineUnknownRemote(gh, "/repo/b");
    assert.strictEqual(spawns.length, 2);
  }),
);

it.effect("retries a failed gh auth probe after ten seconds", () =>
  Effect.gen(function* () {
    const { spawns, process } = recordingProcess((input) =>
      Effect.fail(
        new VcsProcessTimeoutError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: 5_000,
        }),
      ),
    );
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    yield* Effect.flip(probes.refineUnknownRemote(gh, "/repo/a"));
    yield* TestClock.adjust(Duration.seconds(9));
    yield* Effect.flip(probes.refineUnknownRemote(gh, "/repo/b"));
    assert.strictEqual(spawns.length, 1);

    yield* TestClock.adjust(Duration.seconds(1));
    yield* Effect.flip(probes.refineUnknownRemote(gh, "/repo/b"));
    assert.strictEqual(spawns.length, 2);
  }),
);

it.effect("runs a repository-dependent probe for every caller", () =>
  Effect.gen(function* () {
    const { spawns, process } = recordingProcess(() => Effect.succeed(output));
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    yield* probes.refineUnknownRemote(GitLabSourceControlProvider.discovery, "/repo/a");
    yield* probes.refineUnknownRemote(GitLabSourceControlProvider.discovery, "/repo/a");

    assert.deepStrictEqual(spawns, ["/repo/a", "/repo/a"]);
  }),
);

it.effect("a reset makes the next caller probe again", () =>
  Effect.gen(function* () {
    const { spawns, process } = recordingProcess(() => Effect.succeed(output));
    const probes = yield* makeSourceControlDiscoveryProbes(process);

    yield* probes.refineUnknownRemote(gh, "/repo/a");
    yield* probes.reset;
    yield* probes.refineUnknownRemote(gh, "/repo/a");

    assert.strictEqual(spawns.length, 2);
  }),
);
