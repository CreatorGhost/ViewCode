import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { resolveViewCodeSshCliRunner } from "./ViewCodeSshRuntimePolicy.ts";

const configuration = {
  explicitEntryPath: undefined,
  appVersion: "0.1.0",
  nodeEngineRange: "^24.13.1",
};

it.effect(
  "refuses an automatic archive before probing SSH, launching a process or downloading a runtime",
  () =>
    Effect.gen(function* () {
      let spawned = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawned++;
          throw new Error(
            "No SSH or downloader process may start when the runtime policy denies installation",
          );
        }),
      );
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const failure = yield* manager
        .ensureEnvironment({
          alias: "remote",
          hostname: "remote.example.invalid",
          username: null,
          port: null,
        })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeHttpClient.layerUndici,
              NetService.layer,
              SshAuth.SshPasswordPrompt.disabledLayer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
          Effect.flip,
        );
      assert.equal(failure._tag, "SshLaunchError");
      assert.include(failure.message, "Install and start ViewCode on the remote host");
      assert.include(failure.message, "pair with its reachable address");
      assert.equal(spawned, 0);
    }).pipe(
      Effect.provide(
        SshTunnel.SshEnvironmentManager.layer({
          resolveCliRunner: resolveViewCodeSshCliRunner(configuration),
        }),
      ),
    ),
);

it.effect("keeps an explicit remote ViewCode entry usable with managed installation disabled", () =>
  Effect.gen(function* () {
    const runner = yield* resolveViewCodeSshCliRunner({
      ...configuration,
      explicitEntryPath: " /remote/ViewCode checkout/apps/server/dist/bin.mjs ",
    });
    assert.equal(runner.archiveVersion, undefined);
    assert.equal(runner.nodeEngineRange, "^24.13.1");
    const script = SshTunnel.buildRemoteT3RunnerScript(runner);
    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/remote/ViewCode checkout/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "T3_ARCHIVE_VERSION=''");
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );
  }),
);

it.effect(
  "treats a whitespace-only override as absent instead of enabling the upstream archive",
  () =>
    Effect.gen(function* () {
      const failure = yield* resolveViewCodeSshCliRunner({
        ...configuration,
        explicitEntryPath: "  ",
      }).pipe(Effect.flip);
      assert.equal(failure._tag, "SshLaunchError");
    }),
);

it.effect(
  "retains the upstream archive runner only when the product policy explicitly enables it",
  () =>
    Effect.gen(function* () {
      const runner = yield* resolveViewCodeSshCliRunner(configuration, true);
      assert.equal(runner.archiveVersion, "0.1.0");
      const script = SshTunnel.buildRemoteT3RunnerScript(runner);
      assert.include(script, "T3_ARCHIVE_VERSION='0.1.0'");
      assert.include(script, 't3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS"');
    }),
);
