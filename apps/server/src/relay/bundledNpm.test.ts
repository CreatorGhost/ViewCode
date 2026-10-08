import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUNDLED_NPM_VERSION,
  ensureBundledNpm,
  matchesIntegrity,
  nodeShim,
  readTarFiles,
} from "./bundledNpm.ts";

const encoder = new TextEncoder();

/** One tar entry in the ustar layout npm packs (name, mode, size, type, ustar magic, prefix). */
function tarEntry(input: {
  readonly name: string;
  readonly prefix?: string;
  readonly type?: string;
  readonly mode?: number;
  readonly data?: string;
}): Uint8Array {
  const data = encoder.encode(input.data ?? "");
  const header = new Uint8Array(512);
  const put = (offset: number, value: string) => header.set(encoder.encode(value), offset);
  put(0, input.name);
  put(100, `${(input.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
  put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
  put(156, input.type ?? "0");
  put(257, "ustar\u000000");
  put(345, input.prefix ?? "");
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return new Uint8Array([...header, ...padded]);
}

const tar = (...entries: ReadonlyArray<Uint8Array>) =>
  new Uint8Array([...entries.flatMap((entry) => [...entry]), ...new Uint8Array(1024)]);

const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
};

describe("matchesIntegrity", () => {
  const bytes = encoder.encode("npm tarball bytes");
  const integrity = `sha512-${NodeCrypto.createHash("sha512").update(bytes).digest("base64")}`;

  it("accepts the bytes the pinned sha512 describes", () => {
    expect(matchesIntegrity(bytes, integrity)).toBe(true);
  });

  it("rejects other bytes, another hash and a malformed value", () => {
    expect(matchesIntegrity(encoder.encode("npm tarball bytez"), integrity)).toBe(false);
    const sha1 = `sha1-${NodeCrypto.createHash("sha1").update(bytes).digest("base64")}`;
    expect(matchesIntegrity(bytes, sha1)).toBe(false);
    expect(matchesIntegrity(bytes, "sha512-")).toBe(false);
  });
});

describe("nodeShim", () => {
  it("is a cmd file on Windows that quotes the executable and keeps the exit code", () => {
    const shim = nodeShim("win32", "C:\\Program Files\\ViewCode 100%\\ViewCode.exe");
    expect(shim.fileName).toBe("node.cmd");
    expect(shim.content).toBe(
      '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\ViewCode 100%%\\ViewCode.exe" %*\r\nexit /b %ERRORLEVEL%\r\n',
    );
  });

  it("is a shell script elsewhere that execs the executable with every argument", () => {
    const shim = nodeShim("darwin", "/Applications/View Code's.app/Contents/MacOS/ViewCode");
    expect(shim.fileName).toBe("node");
    expect(shim.content).toBe(
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/Applications/View Code'"'"'s.app/Contents/MacOS/ViewCode' "$@"\n`,
    );
  });
});

describe("readTarFiles", () => {
  it("reads files below the package folder, with long names, modes and data", () => {
    const longDir = `${"node_modules/".repeat(9)}deep`;
    const files = readTarFiles(
      tar(
        tarEntry({ name: "package/", type: "5", mode: 0o755 }),
        tarEntry({ name: "package/bin/npx-cli.js", mode: 0o755, data: "#!/usr/bin/env node\n" }),
        tarEntry({ name: "index.js", prefix: `package/${longDir}`, data: "module.exports = 1\n" }),
        tarEntry({
          name: "PaxHeader",
          type: "x",
          data: paxRecord("path", "package/a/pax-name.js"),
        }),
        tarEntry({ name: "package/a/truncated", data: "pax\n" }),
      ),
    );
    expect(files.map(({ path, mode }) => ({ path, mode }))).toEqual([
      { path: "bin/npx-cli.js", mode: 0o755 },
      { path: `${longDir}/index.js`, mode: 0o644 },
      { path: "a/pax-name.js", mode: 0o644 },
    ]);
    expect(new TextDecoder().decode(files[0]!.data)).toBe("#!/usr/bin/env node\n");
  });

  it("refuses a path that leaves the package", () => {
    expect(() => readTarFiles(tar(tarEntry({ name: "package/../../evil.js" })))).toThrow(
      /Unsafe path/u,
    );
  });
});

describe("ensureBundledNpm", () => {
  it.effect("uses an unpacked copy without downloading again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-npm-test-" });
      const npmDir = path.join(cacheDir, `npm-${BUNDLED_NPM_VERSION}`);
      yield* fs.makeDirectory(path.join(npmDir, "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(npmDir, "bin", "npx-cli.js"), "");
      let downloads = 0;
      const found = yield* ensureBundledNpm({
        cacheDir,
        onDownload: Effect.sync(() => {
          downloads += 1;
        }),
      });
      expect(found).toBe(npmDir);
      expect(downloads).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
