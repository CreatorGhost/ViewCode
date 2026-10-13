import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DroidSettings } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { checkDroidProviderStatus } from "./DroidProvider.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

// A stand-in for `droid`: `--version` prints a version and `exec -m ?` lists
// models on stderr and exits 1, as droid 0.240.0 does.
const fakeDroidSource = [
  'if (process.argv[2] === "--version") {',
  '  process.stdout.write("0.240.0\\n");',
  "  process.exit(0);",
  "}",
  'if (process.argv[2] === "exec") {',
  '  process.stderr.write("Invalid model: ?\\n\\nAvailable built-in models:\\n  auto, gpt-6-sol\\n");',
  "  process.exit(1);",
  "}",
  "process.exit(9);",
  "",
].join("\n");

const probe = (input: { readonly login: boolean; readonly apiKey?: string }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-droid-probe-" });
      if (input.login) {
        yield* fs.makeDirectory(path.join(home, ".factory"), { recursive: true });
        yield* fs.writeFileString(path.join(home, ".factory", "auth.v2.file"), "sealed");
      }
      const binaryPath = writeFakeCli({ directory: home, name: "droid", source: fakeDroidSource });
      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete environment.FACTORY_HOME_OVERRIDE;
      delete environment.FACTORY_API_KEY;
      if (input.apiKey) environment.FACTORY_API_KEY = input.apiKey;
      return yield* checkDroidProviderStatus(
        decodeDroidSettings({ enabled: true, binaryPath }),
        environment,
      );
    }),
  );

it.layer(NodeServices.layer)("checkDroidProviderStatus", (it) => {
  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDroidProviderStatus(
        decodeDroidSettings({ enabled: true, binaryPath: "/definitely/not/installed/droid" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
    }),
  );

  it.effect("reads the version, the stored login and the model list", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({ login: true });
      expect(snapshot.version).toBe("0.240.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "cached_token" });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "auto", "gpt-6-sol"]);
    }),
  );

  it.effect("counts FACTORY_API_KEY as signed in", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({ login: false, apiKey: "fk-test" });
      expect(snapshot.auth).toMatchObject({ status: "authenticated", type: "api_key" });
    }),
  );

  it.effect("warns, without blocking, when Droid has no login", () =>
    Effect.gen(function* () {
      const snapshot = yield* probe({ login: false });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("Droid is not signed in");
    }),
  );
});
