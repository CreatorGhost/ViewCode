import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";

const InstalledPackage = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String.check(
      Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    ),
  }),
);
const decodeInstalledPackage = Schema.decodeUnknownEffect(InstalledPackage);

export class ViewcodeNpmDependencyError extends Schema.TaggedError<ViewcodeNpmDependencyError>()(
  "ViewcodeNpmDependencyError",
  {
    dependency: Schema.String,
    specifier: Schema.String,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cannot resolve ${this.dependency} (${this.specifier}) for the ViewCode npm package from ${this.manifestPath}. Install the workspace dependencies before packaging.`;
  }
}

/** npm cannot consume workspace catalogs; resolve only selected catalog roots at their server installation. */
export const resolveViewcodeNpmDependencies = Effect.fn("resolveViewcodeNpmDependencies")(
  function* (input: {
    readonly serverDir: string;
    readonly dependencies: Readonly<Record<string, string>>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const selected = selectCliRuntimeExternalDependencies(input.dependencies);
    const resolved: Record<string, string> = {};
    for (const [dependency, specifier] of Object.entries(selected)) {
      if (!specifier.startsWith("catalog:")) {
        resolved[dependency] = specifier;
        continue;
      }
      // Read directly: package exports may forbid package.json, and the repo root may install a different version.
      const manifestPath = path.join(input.serverDir, "node_modules", dependency, "package.json");
      const manifest = yield* fs.readFileString(manifestPath).pipe(
        Effect.flatMap(decodeInstalledPackage),
        Effect.mapError(
          (cause) => new ViewcodeNpmDependencyError({ dependency, specifier, manifestPath, cause }),
        ),
      );
      resolved[dependency] = manifest.version;
    }
    return resolved;
  },
);
