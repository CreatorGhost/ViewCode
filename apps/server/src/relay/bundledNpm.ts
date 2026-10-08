// @effect-diagnostics nodeBuiltinImport:off - Hashes and unpacks the npm tarball.
/**
 * npm for Quick connect setup on a desktop with no Node.js installed. The
 * desktop app's Electron binary is a Node (`ELECTRON_RUN_AS_NODE=1`), so only
 * npm's own `npx` is missing: setup downloads one pinned npm release from the
 * registry once, checks it against the integrity pinned here, and unpacks it
 * under the T3 home. wrangler itself is still fetched by `npx` as usual; it is
 * not bundled because its `workerd` dependency is about 100 MB per platform.
 *
 * Whatever runs `node` below npx (wrangler's shebang, npm install scripts,
 * esbuild's postinstall) finds the `node` shim from `nodeShim` on PATH.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as Undici from "@effect/platform-node/Undici";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** npm 11 runs on Node 20.17+ and 22.9+, so it fits every Electron that can run wrangler 4. */
export const BUNDLED_NPM_VERSION = "11.20.0";
/** `dist.integrity` of npm@11.20.0 in the registry metadata. Changing the version means changing this. */
export const BUNDLED_NPM_INTEGRITY =
  "sha512-dF3EDFwbYN+N5RUip+ZYDe0NeURK5BgqKOcvT1iNtUYhTMTl0FwWhBuXrS7KtXyduqyTMS5aaQaregnHDAxNgw==";
const TARBALL_URL = `https://registry.npmjs.org/npm/-/npm-${BUNDLED_NPM_VERSION}.tgz`;
const DOWNLOAD_TIMEOUT = Duration.minutes(2);
const WRITE_CONCURRENCY = 16;

/** Where `npx-cli.js` lives inside the unpacked package. */
export const NPX_CLI_PATH = ["bin", "npx-cli.js"] as const;

/** Whether `bytes` match an npm `sha512-<base64>` integrity string. */
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512" || expected === undefined || expected === "") return false;
  const actual = NodeCrypto.createHash("sha512").update(bytes).digest();
  const wanted = Buffer.from(expected, "base64");
  return wanted.length === actual.length && NodeCrypto.timingSafeEqual(actual, wanted);
}

const cmdQuote = (value: string) => `"${value.replaceAll("%", "%%")}"`;
const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * A `node` that is this Electron binary run as Node, forwarding arguments,
 * stdio and exit code: `node.cmd` for cmd.exe on Windows, a shell script elsewhere.
 */
export function nodeShim(
  platform: NodeJS.Platform,
  executable: string,
): { readonly fileName: string; readonly content: string } {
  if (platform === "win32") {
    return {
      fileName: "node.cmd",
      content: `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n${cmdQuote(executable)} %*\r\nexit /b %ERRORLEVEL%\r\n`,
    };
  }
  return {
    fileName: "node",
    content: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} "$@"\n`,
  };
}

export interface TarFile {
  /** Relative to the package root (`package/` removed), `/`-separated. */
  readonly path: string;
  readonly mode: number;
  readonly data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

const readString = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};
const readOctal = (block: Uint8Array, start: number, length: number) =>
  Number.parseInt(readString(block, start, length).trim() || "0", 8);

/** The `path` record of a pax extended header, if any. */
function paxPath(data: Uint8Array): string | undefined {
  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The regular files of an uncompressed npm package tarball (ustar, with pax
 * or GNU long names). Directories come from the file paths; links, which npm
 * never packs, are skipped. Throws on a path that would leave the package.
 */
export function readTarFiles(tar: Uint8Array): ReadonlyArray<TarFile> {
  const files: TarFile[] = [];
  let longName: string | undefined;
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header[0] === 0) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = readString(header, 345, 155);
    const name = longName ?? (prefix === "" ? "" : `${prefix}/`) + readString(header, 0, 100);
    longName = undefined;
    if (type !== "0" && type !== "\0") continue;

    const parts = name
      .replaceAll("\\", "/")
      .split("/")
      .filter((part) => part !== "" && part !== ".");
    if (parts.includes("..") || /^[a-z]:$/iu.test(parts[0] ?? "")) {
      throw new Error(`Unsafe path in the npm package: ${name}`);
    }
    // npm packs everything under one top folder, normally `package/`.
    const path = parts.slice(1).join("/");
    if (path === "") continue;
    files.push({ path, mode: readOctal(header, 100, 8) & 0o777, data });
  }
  return files;
}

const gunzip = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      new Promise<Uint8Array>((resolve, reject) =>
        NodeZlib.gunzip(bytes, (error, result) => (error ? reject(error) : resolve(result))),
      ),
    catch: (cause) => `Could not unpack npm: ${String(cause)}`,
  });

/** Through the same proxy wrangler and npm use (`HTTPS_PROXY`, `NO_PROXY`). */
const download = Effect.tryPromise({
  try: async (signal) => {
    const response = await Undici.fetch(TARBALL_URL, {
      dispatcher: new Undici.EnvHttpProxyAgent(),
      signal,
    });
    if (!response.ok) throw new Error(`the registry answered ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  catch: (cause) =>
    `Could not download npm ${BUNDLED_NPM_VERSION}: ${cause instanceof Error ? cause.message : String(cause)}`,
}).pipe(
  Effect.timeoutOrElse({
    duration: DOWNLOAD_TIMEOUT,
    orElse: () => Effect.fail(`Could not download npm ${BUNDLED_NPM_VERSION}: no answer in time.`),
  }),
);

/**
 * The unpacked npm under `cacheDir`, downloading it the first time
 * (`onDownload` runs first, for the progress message). Unpacked into a
 * side folder and renamed into place, so a half-written copy is never used.
 * Fails with one sentence for the setup details.
 */
export const ensureBundledNpm = (input: {
  readonly cacheDir: string;
  readonly onDownload: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const npmDir = path.join(input.cacheDir, `npm-${BUNDLED_NPM_VERSION}`);
    const ready = yield* fs
      .exists(path.join(npmDir, ...NPX_CLI_PATH))
      .pipe(Effect.orElseSucceed(() => false));
    if (ready) return npmDir;

    yield* input.onDownload;
    const tarball = yield* download;
    if (!matchesIntegrity(tarball, BUNDLED_NPM_INTEGRITY)) {
      return yield* Effect.fail(
        `The downloaded npm ${BUNDLED_NPM_VERSION} did not match its expected checksum.`,
      );
    }
    const files = yield* gunzip(tarball).pipe(
      Effect.flatMap((tar) =>
        Effect.try({
          try: () => readTarFiles(tar),
          catch: (cause) => `Could not unpack npm: ${String(cause)}`,
        }),
      ),
    );

    const writeFailed = (cause: unknown) => `Could not save npm on this computer: ${String(cause)}`;
    yield* fs.makeDirectory(input.cacheDir, { recursive: true }).pipe(Effect.mapError(writeFailed));
    const partial = yield* fs
      .makeTempDirectory({ directory: input.cacheDir, prefix: `npm-${BUNDLED_NPM_VERSION}-` })
      .pipe(Effect.mapError(writeFailed));
    const install = Effect.gen(function* () {
      const dirs = new Set(files.map((file) => path.dirname(path.join(partial, file.path))));
      yield* Effect.forEach(dirs, (dir) => fs.makeDirectory(dir, { recursive: true }), {
        concurrency: WRITE_CONCURRENCY,
        discard: true,
      });
      yield* Effect.forEach(
        files,
        (file) =>
          fs.writeFile(path.join(partial, file.path), file.data, {
            mode: file.mode === 0 ? 0o644 : file.mode,
          }),
        { concurrency: WRITE_CONCURRENCY, discard: true },
      );
      // Not a usable copy (the check above failed), e.g. one left by an older crash.
      yield* fs.remove(npmDir, { recursive: true, force: true });
      yield* fs.rename(partial, npmDir);
    }).pipe(Effect.mapError(writeFailed));
    yield* install.pipe(
      Effect.onError(() =>
        fs.remove(partial, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    return npmDir;
  });
