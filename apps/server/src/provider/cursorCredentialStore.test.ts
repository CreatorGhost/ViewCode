import { assert, describe, expect, it } from "@effect/vitest";

import {
  cursorCliLoginIdentity,
  cursorTokenMatchesIdentity,
  makeCachedKeychainSecretReader,
} from "./cursorCredentialStore.ts";

describe("Cursor Keychain reader", () => {
  it("tracks the CLI account independently of preference changes and rejects mismatched tokens", () => {
    const config = (model: string) => JSON.stringify({ model, authInfo: { authId: "user-a" } });
    assert.strictEqual(
      cursorCliLoginIdentity(config("first")),
      cursorCliLoginIdentity(config("second")),
    );
    const token = `header.${Buffer.from(JSON.stringify({ sub: "user-a" })).toString("base64url")}.signature`;
    assert.isTrue(cursorTokenMatchesIdentity(token, "user-a"));
    assert.isFalse(cursorTokenMatchesIdentity(token, "user-b"));
    assert.isFalse(cursorTokenMatchesIdentity("invalid", "user-a"));
    assert.throws(() => cursorCliLoginIdentity("{}"));
  });
  it("shares concurrent reads and keeps the credential until the CLI login changes", async () => {
    let reads = 0;
    let revision = "account-a";
    const read = makeCachedKeychainSecretReader(
      async () => `token-${++reads}`,
      async () => revision,
    );
    assert.deepStrictEqual(await Promise.all([read(), read()]), ["token-1", "token-1"]);
    for (let index = 0; index < 20; index++) assert.strictEqual(await read(), "token-1");
    assert.strictEqual(reads, 1);
    revision = "account-b";
    assert.strictEqual(await read(), "token-2");
  });

  it("does not reopen Keychain after a denied read until explicitly retried", async () => {
    let reads = 0;
    const read = makeCachedKeychainSecretReader(async () => {
      if (++reads === 1) throw new Error("access denied");
      return "granted";
    });
    await expect(read()).rejects.toThrow(/access denied/);
    await expect(read()).rejects.toThrow(/access denied/);
    assert.strictEqual(reads, 1);
    read.invalidate();
    assert.strictEqual(await read(), "granted");
  });

  it("caches missing credentials and synchronous bridge failures", async () => {
    let reads = 0;
    const missing = makeCachedKeychainSecretReader(async () => {
      reads++;
      return null;
    });
    assert.strictEqual(await missing(), null);
    assert.strictEqual(await missing(), null);
    assert.strictEqual(reads, 1);
    const failed = makeCachedKeychainSecretReader(() => {
      reads++;
      throw new Error("native module unavailable");
    });
    await expect(failed()).rejects.toThrow(/native module unavailable/);
    await expect(failed()).rejects.toThrow(/native module unavailable/);
    assert.strictEqual(reads, 2);
  });

  it("reloads a rejected token once without repeatedly prompting for the same item", async () => {
    let reads = 0;
    const read = makeCachedKeychainSecretReader(async () => {
      reads++;
      return "stale";
    });
    assert.strictEqual(await read(), "stale");
    read.rejectToken("stale");
    assert.strictEqual(await read(), "stale");
    read.rejectToken("stale");
    assert.strictEqual(await read(), "stale");
    assert.strictEqual(reads, 2);
    read.invalidate();
    assert.strictEqual(await read(), "stale");
    assert.strictEqual(reads, 3);
  });

  it("reloads a rotated token after rejection and does not reuse an account whose config is unreadable", async () => {
    let available = true;
    let reads = 0;
    const read = makeCachedKeychainSecretReader(
      async () => `token-${++reads}`,
      async () => {
        if (!available) throw new Error("login config unavailable");
        return "account";
      },
    );
    assert.strictEqual(await read(), "token-1");
    read.rejectToken("token-1");
    assert.strictEqual(await read(), "token-2");
    available = false;
    await expect(read()).rejects.toThrow(/login config unavailable/);
    assert.strictEqual(reads, 2);
    available = true;
    assert.strictEqual(await read(), "token-3");
  });
});
