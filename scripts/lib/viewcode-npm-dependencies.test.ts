import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import {
  resolveViewcodeNpmDependencies,
  ViewcodeNpmDependencyError,
} from "./viewcode-npm-dependencies.ts";

it.layer(NodeServices.layer)("ViewCode npm dependencies", (it) => {
  it.effect(
    "resolves default and named catalogs from server installs while preserving explicit roots",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const serverDir = path.join(root, "apps", "server");
        for (const [location, version] of [
          [path.join(root, "node_modules", "undici"), "99.0.0"],
          [path.join(serverDir, "node_modules", "undici"), "8.11.2"],
          [path.join(serverDir, "node_modules", "@cursor", "sdk"), "0.3.7"],
        ] as const) {
          yield* fs.makeDirectory(location, { recursive: true });
          yield* fs.writeFileString(
            path.join(location, "package.json"),
            JSON.stringify({ version }),
          );
        }
        assert.deepStrictEqual(
          yield* resolveViewcodeNpmDependencies({
            serverDir,
            dependencies: {
              undici: "catalog:",
              "@cursor/sdk": "catalog:runtime",
              "node-pty": "^1.1.0",
              effect: "catalog:not-installed",
            },
          }),
          { undici: "8.11.2", "@cursor/sdk": "0.3.7", "node-pty": "^1.1.0" },
        );
      }),
  );

  it.effect(
    "fails on a missing selected manifest instead of falling back to another installation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "node_modules", "undici"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "node_modules", "undici", "package.json"),
          '{"version":"99.0.0"}',
        );
        const serverDir = path.join(root, "apps", "server");
        const error = yield* resolveViewcodeNpmDependencies({
          serverDir,
          dependencies: { undici: "catalog:runtime" },
        }).pipe(Effect.flip);
        assert.instanceOf(error, ViewcodeNpmDependencyError);
        assert.strictEqual(error.dependency, "undici");
        assert.strictEqual(
          error.manifestPath,
          path.join(serverDir, "node_modules", "undici", "package.json"),
        );
      }),
  );

  it.effect("refuses a malformed installed version before producing an npm manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverDir = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(serverDir, "node_modules", "undici");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "package.json"),
        '{"version":"catalog:invalid"}',
      );
      const error = yield* resolveViewcodeNpmDependencies({
        serverDir,
        dependencies: { undici: "catalog:" },
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ViewcodeNpmDependencyError");
    }),
  );

  it.effect(
    "makes the actual server dependency selection npm-compatible with the installed undici version",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const serverDir = yield* path.fromFileUrl(new URL("../../apps/server/", import.meta.url));
        const result = yield* resolveViewcodeNpmDependencies({
          serverDir,
          dependencies: serverPackageJson.dependencies,
        });
        assert.deepStrictEqual(
          Object.keys(result).sort(),
          Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
        );
        assert.strictEqual(result.undici, "8.11.2");
        assert.strictEqual(
          Object.values(result).some((value) => value.startsWith("catalog:")),
          false,
        );
        assert.strictEqual(result["node-pty"], serverPackageJson.dependencies["node-pty"]);
      }),
  );
});
