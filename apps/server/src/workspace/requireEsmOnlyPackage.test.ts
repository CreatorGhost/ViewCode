import * as NodeModule from "node:module";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";

import { requireEsmOnlyPackage } from "./requireEsmOnlyPackage.ts";

const makePackage = Effect.fn("makePackage")(function* (exportsJson: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "esm-only-" });
  const packageDir = path.join(root, "node_modules", "esm-only");
  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDir, "package.json"),
    `{"name":"esm-only","type":"module","exports":{".":${exportsJson}}}`,
  );
  const entry = path.join(packageDir, "index.js");
  yield* fs.writeFileString(entry, "export const value = 42;\n");
  return {
    require: NodeModule.createRequire(path.join(root, "main.js")),
    entryUrl: (yield* path.toFileUrl(entry)).href,
  };
});

describe("requireEsmOnlyPackage", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("requires a package whose exports offer a require condition", () =>
      Effect.gen(function* () {
        const fixture = yield* makePackage('{"import":"./index.js","require":"./index.js"}');
        const loaded = requireEsmOnlyPackage<{ value: number }>(
          fixture.require,
          () => {
            throw new Error("the ESM resolver is only for import-only packages");
          },
          "esm-only",
        );
        expect(loaded.value).toBe(42);
      }).pipe(Effect.scoped),
    );

    it.effect("loads an import-only package by its resolved entry path", () =>
      Effect.gen(function* () {
        const fixture = yield* makePackage('{"import":"./index.js"}');
        const loaded = requireEsmOnlyPackage<{ value: number }>(
          fixture.require,
          () => fixture.entryUrl,
          "esm-only",
        );
        expect(loaded.value).toBe(42);
      }).pipe(Effect.scoped),
    );

    it.effect("rethrows other load failures", () =>
      Effect.gen(function* () {
        const fixture = yield* makePackage('{"import":"./index.js"}');
        expect(() =>
          requireEsmOnlyPackage(fixture.require, () => fixture.entryUrl, "missing-package"),
        ).toThrow(/Cannot find module/);
      }).pipe(Effect.scoped),
    );
  });
});
