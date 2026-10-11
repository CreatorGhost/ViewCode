import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  detectTailscaleInstalled,
  shouldAutoEnableTailscaleServe,
} from "./DesktopTailscalePhoneAccess.ts";

describe("shouldAutoEnableTailscaleServe", () => {
  const off = { tailscaleServeEnabled: false } as const;

  it("stays off by default, even when Tailscale is installed", () => {
    assert.isFalse(shouldAutoEnableTailscaleServe({ settings: off, installed: true }));
  });

  it("needs the opt-in and an installed CLI", () => {
    const optedIn = { ...off, tailscaleAutoServe: true } as const;
    assert.isTrue(shouldAutoEnableTailscaleServe({ settings: optedIn, installed: true }));
    assert.isFalse(shouldAutoEnableTailscaleServe({ settings: optedIn, installed: false }));
  });

  it("leaves a Serve that is already on alone", () => {
    assert.isFalse(
      shouldAutoEnableTailscaleServe({
        settings: { tailscaleServeEnabled: true, tailscaleAutoServe: true },
        installed: true,
      }),
    );
  });
});

describe("detectTailscaleInstalled", () => {
  // A platform with no known install paths, so the result depends on PATH alone
  // and not on whether this machine has Tailscale.
  const onlyPathCounts = Effect.provideService(HostProcessPlatform, "freebsd");

  it.effect("finds the CLI on PATH by looking at files only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fileSystem.makeTempDirectoryScoped();
      const installed = yield* fileSystem.makeTempDirectoryScoped();
      const cli = path.join(installed, "tailscale");
      yield* fileSystem.writeFileString(cli, "#!/bin/sh\n");
      yield* fileSystem.chmod(cli, 0o755);
      assert.isFalse(yield* detectTailscaleInstalled({ PATH: empty }));
      assert.isTrue(yield* detectTailscaleInstalled({ PATH: installed }));
    }).pipe(Effect.scoped, onlyPathCounts, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an empty PATH as not installed", () =>
    detectTailscaleInstalled({ PATH: "" }).pipe(
      Effect.map((installed) => assert.isFalse(installed)),
      onlyPathCounts,
      Effect.provide(NodeServices.layer),
    ),
  );
});
