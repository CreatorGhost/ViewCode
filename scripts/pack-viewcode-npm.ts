#!/usr/bin/env node
/**
 * Packs the built server (`apps/server/dist`, web client included) as an npm
 * package whose `viewcode` command serves ViewCode to a browser:
 *
 *   pnpm exec vp run --filter t3 build
 *   node scripts/pack-viewcode-npm.ts [--name viewcode-app]
 *   npm install -g apps/server/dist-npm/<name>-<version>.tgz   (or `npm publish` it)
 *
 * Unlike the `t3` launcher and its per-platform executables, this runs on the
 * user's own Node and lets npm fetch the native addons for their platform, so
 * one tarball serves every OS and nothing in it needs code signing.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

// Trust the OS certificate store as well as Node's bundled roots, as the
// desktop backend does, so HTTPS works behind a TLS-inspecting proxy.
const BIN_SHEBANG = "#!/usr/bin/env -S node --use-system-ca";

const encodePackageJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

class ViewcodeNpmPackError extends Schema.TaggedError<ViewcodeNpmPackError>()(
  "ViewcodeNpmPackError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function viewcodeNpmManifest(name: string) {
  return {
    name,
    version: serverPackageJson.version,
    description: "ViewCode, a GUI for coding agents, served to your browser.",
    license: serverPackageJson.license,
    repository: { type: "git", url: "https://github.com/CreatorGhost/ViewCode" },
    type: "module",
    bin: { viewcode: "dist/bin.mjs" },
    files: ["dist"],
    // Everything else is inside the bundle; these load native code at runtime.
    dependencies: selectCliRuntimeExternalDependencies(serverPackageJson.dependencies),
    engines: serverPackageJson.engines,
  };
}

const README = `# ViewCode

A GUI for coding agents, served to your browser.

\`\`\`sh
npm install -g <this package>
viewcode
\`\`\`

\`viewcode\` starts the server and opens the app in your browser. Run
\`viewcode --help\` for options. Source: https://github.com/CreatorGhost/ViewCode
`;

const packViewcodeNpm = Effect.fn("packViewcodeNpm")(function* (input: { readonly name: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverDir = yield* path.fromFileUrl(new URL("../apps/server/", import.meta.url));
  const distDir = path.join(serverDir, "dist");
  const outputDir = path.join(serverDir, "dist-npm");
  const stageDir = path.join(outputDir, "package");

  if (!(yield* fs.exists(path.join(distDir, "client", "index.html")))) {
    return yield* new ViewcodeNpmPackError({
      detail: `${distDir} has no built server and client. Run \`pnpm exec vp run --filter t3 build\` first.`,
    });
  }

  yield* fs.remove(outputDir, { recursive: true, force: true });
  yield* fs.makeDirectory(stageDir, { recursive: true });
  yield* fs.copy(distDir, path.join(stageDir, "dist"));
  // Source maps are half the size and only help when debugging the bundle.
  for (const entry of yield* fs.readDirectory(path.join(stageDir, "dist"), { recursive: true })) {
    if (entry.endsWith(".map")) yield* fs.remove(path.join(stageDir, "dist", entry));
  }
  const bin = path.join(stageDir, "dist", "bin.mjs");
  const source = yield* fs.readFileString(bin);
  yield* fs.writeFileString(bin, source.replace(/^#!.*\n/, `${BIN_SHEBANG}\n`));
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    `${yield* encodePackageJson(viewcodeNpmManifest(input.name))}\n`,
  );
  yield* fs.writeFileString(path.join(stageDir, "README.md"), README);
  // MIT requires the notice to travel with every copy.
  yield* fs.copyFile(
    yield* path.fromFileUrl(new URL("../LICENSE", import.meta.url)),
    path.join(stageDir, "LICENSE"),
  );

  const child = yield* spawner.spawn(
    ChildProcess.make("npm", ["pack", "--pack-destination", outputDir], {
      cwd: stageDir,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new ViewcodeNpmPackError({ detail: `npm pack exited with code ${exitCode}.` });
  }
  const tarball = `${input.name.replace(/^@/, "").replace("/", "-")}-${serverPackageJson.version}.tgz`;
  yield* Effect.log(`[viewcode-npm] Wrote ${path.join(outputDir, tarball)}`);
}, Effect.scoped);

const command = Command.make(
  "pack-viewcode-npm",
  {
    name: Flag.String("name").pipe(
      Flag.withDefault("viewcode-app"),
      Flag.withDescription("npm package name; a scoped name must be one your npm account owns."),
    ),
  },
  packViewcodeNpm,
).pipe(Command.withDescription("Pack the built server and web client as a viewcode npm package."));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
  NodeRuntime.runMain,
);
