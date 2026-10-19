import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { detectProviders, resolveInstanceExecutable } from "./providerDetection.ts";

describe("first-run filesystem discovery", () => {
  it.effect(
    "finds configured executables with instance environment without requiring a process spawner",
    () =>
      Effect.gen(function* () {
        const lookups: Array<{ command: string; path: string | undefined }> = [];
        const found = yield* detectProviders({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("commandCode")]: {
              driver: ProviderDriverKind.make("commandCode"),
              enabled: false,
              config: { binaryPath: "~/tools/cmd" },
              environment: [{ name: "PATH", value: "/private/tools", sensitive: false }],
            },
            [ProviderInstanceId.make("opencode")]: {
              driver: ProviderDriverKind.make("opencode"),
              enabled: false,
              config: { serverUrl: "http://remote:4096" },
            },
          },
        }).pipe(
          Effect.provideService(SpawnExecutableResolution, (command, _platform, env) => {
            lookups.push({ command, path: env.PATH });
            return command === "/test-home/tools/cmd" ? command : undefined;
          }),
        );
        assert.deepEqual(
          found.find((row) => row.driver === "commandCode"),
          {
            driver: ProviderDriverKind.make("commandCode"),
            path: "/test-home/tools/cmd",
            installed: true,
          },
        );
        assert.deepEqual(
          found.find((row) => row.driver === "droid"),
          { driver: ProviderDriverKind.make("droid"), path: null, installed: false },
        );
        assert.isTrue(found.find((row) => row.driver === "opencode")!.installed);
        assert.isTrue(found.find((row) => row.driver === "cursor")!.installed);
        assert.includeDeepMembers(lookups, [
          { command: "/test-home/tools/cmd", path: "/private/tools" },
        ]);
        assert.notInclude(
          lookups.map((entry) => entry.command),
          "opencode",
        );
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(HostProcess.Environment, { PATH: "/original" }),
      ),
  );

  it.effect("resolves an instance's own executable before it is launched", () =>
    Effect.gen(function* () {
      const codex = ProviderDriverKind.make("codex");
      const workCodex = (config: Record<string, unknown>) => ({ driver: codex, config });
      assert.equal(
        yield* resolveInstanceExecutable(codex, workCodex({ binaryPath: "~/bin/codex" })),
        "/test-home/bin/codex",
      );
      assert.isNull(yield* resolveInstanceExecutable(codex, workCodex({ binaryPath: "/gone" })));
      assert.isUndefined(
        yield* resolveInstanceExecutable(codex, workCodex({ setupMode: "managed" })),
      );
      assert.isUndefined(
        yield* resolveInstanceExecutable(ProviderDriverKind.make("acpRegistry"), undefined),
      );
      assert.isUndefined(
        yield* resolveInstanceExecutable(ProviderDriverKind.make("constructor"), undefined),
      );
    }).pipe(
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "/test-home/bin/codex" ? command : undefined,
      ),
      Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
      Effect.provideService(HostProcess.Environment, { PATH: "/original" }),
    ),
  );
});
