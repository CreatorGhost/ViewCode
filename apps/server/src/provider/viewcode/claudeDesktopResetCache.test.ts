import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  parseClaudeDesktopResetCache,
  readClaudeDesktopResetCache,
} from "./claudeDesktopResetCache.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const block = {
  eligible: true,
  grants: [{ id: "saved", resets_left: 1, usable_now: false, ends_at: "2026-10-01T00:00:00Z" }],
};
function entry(options: { url?: string; payload?: unknown; date?: string; body?: Buffer } = {}) {
  const key = Buffer.from(
    `1/0/${options.url ?? "https://claude.ai/api/organizations/org-a/usage?cedar_ember=1"}`,
  );
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n);
  header.writeUInt32LE(key.length, 12);
  return Buffer.concat([
    header,
    key,
    options.body ??
      NodeZlib.zstdCompressSync(
        Buffer.from(JSON.stringify(options.payload ?? { cedar_ember: block })),
      ),
    Buffer.from(`\0date: ${options.date ?? "Mon, 28 Sep 2026 12:00:00 GMT"}\0`),
  ]);
}
const parse = (bytes: Uint8Array, organization = "org-a") =>
  parseClaudeDesktopResetCache({ bytes, organization, modifiedAtMs: NOW, nowMs: NOW });

describe("Claude Desktop reset cache", () => {
  it("reads only an exact account usage URL and dates the response", () => {
    expect(parse(entry())).toEqual({ block, capturedAt: NOW });
    expect(parse(entry(), "org-b")).toBeUndefined();
    for (const url of [
      "https://claude.ai.attacker.test/api/organizations/org-a/usage",
      "https://attacker.test/claude.ai/api/organizations/org-a/usage",
      "http://claude.ai/api/organizations/org-a/usage",
      "https://claude.ai/api/organizations/org-a/usage/other",
    ])
      expect(parse(entry({ url }))).toBeUndefined();
  });

  it("preserves an explicit zero block without substituting an older count", () => {
    const zero = { eligible: true, grants: [] };
    expect(parse(entry({ payload: { cedar_ember: zero } }))?.block).toEqual(zero);
    expect(parse(entry({ payload: { five_hour: {} } }))).toBeUndefined();
  });

  it("rejects stale or future observations even when the file was copied recently", () => {
    for (const date of [
      "Mon, 28 Sep 2026 11:54:59 GMT",
      "Mon, 28 Sep 2026 12:00:01 GMT",
      "invalid",
    ])
      expect(parse(entry({ date }))).toBeUndefined();
    expect(parse(entry({ date: "Mon, 28 Sep 2026 11:55:00 GMT" }))).toBeDefined();
  });

  it("bounds compressed and decompressed data and ignores malformed entries", () => {
    expect(parse(Buffer.alloc(512 * 1024 + 1))).toBeUndefined();
    expect(parse(entry({ payload: { cedar_ember: "x".repeat(300 * 1024) } }))).toBeUndefined();
    expect(parse(entry({ body: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]) }))).toBeUndefined();
    const wrongMagic = entry();
    wrongMagic[0] = 0;
    expect(parse(wrongMagic)).toBeUndefined();
    const badLength = entry();
    badLength.writeUInt32LE(0xffffffff, 12);
    expect(parse(badLength)).toBeUndefined();
    expect(
      parse(entry({ body: NodeZlib.zstdCompressSync(Buffer.from("not json")) })),
    ).toBeUndefined();
  });

  it.effect("uses the selected instance account and lets a newer zero supersede an old grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const accountA = path.join(directory, "a.json");
        const accountB = path.join(directory, "b.json");
        yield* fs.writeFileString(accountA, '{"oauthAccount":{"organizationUuid":"org-a"}}');
        yield* fs.writeFileString(accountB, '{"oauthAccount":{"organizationUuid":"org-b"}}');
        yield* fs.writeFile(path.join(directory, "abcd_0"), entry());
        expect(
          (yield* readClaudeDesktopResetCache({
            accountConfigPath: accountA,
            cacheDirectory: directory,
          }))?.block,
        ).toEqual(block);
        expect(
          yield* readClaudeDesktopResetCache({
            accountConfigPath: accountB,
            cacheDirectory: directory,
          }),
        ).toBeUndefined();
        const zero = { eligible: true, grants: [] };
        yield* fs.writeFile(
          path.join(directory, "abcd_0"),
          entry({ payload: { cedar_ember: zero } }),
        );
        expect(
          (yield* readClaudeDesktopResetCache({
            accountConfigPath: accountA,
            cacheDirectory: directory,
          }))?.block,
        ).toEqual(zero);
        // A recently copied entry has a newer mtime but an older server response.
        yield* fs.writeFile(
          path.join(directory, "bcde_0"),
          entry({ date: "Mon, 28 Sep 2026 11:59:00 GMT" }),
        );
        yield* fs.utimes(path.join(directory, "bcde_0"), NOW / 1000 + 60, NOW / 1000 + 60);
        expect(
          (yield* readClaudeDesktopResetCache({
            accountConfigPath: accountA,
            cacheDirectory: directory,
          }))?.block,
        ).toEqual(zero);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
