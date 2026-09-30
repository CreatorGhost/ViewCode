/**
 * Where the Quick connect Worker's source comes from when the app deploys it.
 *
 * wrangler bundles the Worker itself at deploy time, so the app only needs the
 * TypeScript sources on disk. A source checkout reads them from
 * `infra/viewcode-relay` and `packages/shared`; the server build copies the
 * same files flat into `dist/viewcode-relay-worker/` (`scripts/cli.ts build`),
 * which ships inside the desktop app and the npm package. Either way setup
 * stages them into a temporary folder with a generated wrangler config whose
 * `alias` points the shared protocol import at the local copy.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseLenientJson } from "@t3tools/shared/viewcodeRelaySetup";

/** The folder the server build writes next to `dist/bin.mjs`. */
export const RELAY_WORKER_BUNDLE_DIR = "viewcode-relay-worker";
/** The Worker's own modules, from `infra/viewcode-relay/src`. */
export const RELAY_WORKER_MODULES = ["worker.ts", "relayDurableObject.ts", "routing.ts"] as const;
export const RELAY_PROTOCOL_MODULE = "viewcodeRelayProtocol.ts";
const PROTOCOL_IMPORT = "@t3tools/shared/viewcodeRelayProtocol";
const WRANGLER_TEMPLATE = "wrangler.jsonc";

/** One file to stage: where it is now, and its flat name in the staged folder. */
export interface RelayWorkerFile {
  readonly from: string;
  readonly name: string;
}

/** The files of a source checkout rooted at `repoRoot`, in staged order. */
export const sourceCheckoutWorkerFiles = (
  path: Path.Path,
  repoRoot: string,
): ReadonlyArray<RelayWorkerFile> => [
  ...RELAY_WORKER_MODULES.map((name) => ({
    from: path.join(repoRoot, "infra/viewcode-relay/src", name),
    name,
  })),
  {
    from: path.join(repoRoot, "packages/shared/src", RELAY_PROTOCOL_MODULE),
    name: RELAY_PROTOCOL_MODULE,
  },
  { from: path.join(repoRoot, "infra/viewcode-relay", WRANGLER_TEMPLATE), name: WRANGLER_TEMPLATE },
];

const bundledWorkerFiles = (path: Path.Path, dir: string): ReadonlyArray<RelayWorkerFile> =>
  [...RELAY_WORKER_MODULES, RELAY_PROTOCOL_MODULE, WRANGLER_TEMPLATE].map((name) => ({
    from: path.join(dir, name),
    name,
  }));

/**
 * Finds the Worker source: the bundled copy beside the built server first,
 * then a source checkout above this module. Null when neither is complete.
 */
export const findRelayWorkerFiles = (here: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const complete = (files: ReadonlyArray<RelayWorkerFile>) =>
      Effect.forEach(files, (file) =>
        fs.exists(file.from).pipe(Effect.orElseSucceed(() => false)),
      ).pipe(Effect.map((found) => found.every(Boolean)));

    const bundled = bundledWorkerFiles(path, path.join(here, RELAY_WORKER_BUNDLE_DIR));
    if (yield* complete(bundled)) return bundled;
    let dir = here;
    for (let depth = 0; depth < 6; depth += 1) {
      const checkout = sourceCheckoutWorkerFiles(path, dir);
      if (yield* complete(checkout)) return checkout;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  });

/**
 * The wrangler config for the staged folder: the committed template with the
 * entry point and the shared protocol import pointed at the flat copies.
 */
export function stagedWranglerConfig(templateText: string): string {
  const template = parseLenientJson(templateText);
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("The relay Worker's wrangler.jsonc is not a JSON object.");
  }
  return `${JSON.stringify(
    {
      ...template,
      main: "worker.ts",
      alias: { [PROTOCOL_IMPORT]: `./${RELAY_PROTOCOL_MODULE}` },
    },
    null,
    2,
  )}\n`;
}

/**
 * Copies the Worker into `dir` and writes `wrangler.json` there. Returns the
 * config path to pass to wrangler.
 */
export const stageRelayWorker = (files: ReadonlyArray<RelayWorkerFile>, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let template = "";
    for (const file of files) {
      if (file.name === WRANGLER_TEMPLATE) {
        template = yield* fs.readFileString(file.from);
        continue;
      }
      yield* fs.copyFile(file.from, path.join(dir, file.name));
    }
    const configPath = path.join(dir, "wrangler.json");
    const config = yield* Effect.try({
      try: () => stagedWranglerConfig(template),
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    });
    yield* fs.writeFileString(configPath, config);
    return configPath;
  });
