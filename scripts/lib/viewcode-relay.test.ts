// @effect-diagnostics nodeBuiltinImport:off - Writes real files to a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  generateHostSecret,
  isValidWorkerName,
  parseLenientJson,
  parseWorkerUrl,
  readRelayState,
  readSecretFile,
  readSettingsFile,
  removeRelayState,
  removeSecretFile,
  secretFilePath,
  withoutRelaySettings,
  withRelaySettings,
  wranglerNeedsLogin,
  writeRelayState,
  writeSecretFile,
  writeSettingsFile,
} from "./viewcode-relay.ts";

const temporaryDirs: string[] = [];
const makeStateDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vc-relay-script-"));
  temporaryDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("parseWorkerUrl", () => {
  it("finds the worker's own address in wrangler output", () => {
    const output = [
      "Total Upload: 20.11 KiB / gzip: 5.02 KiB",
      "Deployed viewcode-relay triggers (1.20 sec)",
      "  https://viewcode-relay.some-account.workers.dev",
      "Current Version ID: 1234",
    ].join("\n");
    expect(parseWorkerUrl(output, "viewcode-relay")).toBe(
      "https://viewcode-relay.some-account.workers.dev",
    );
    expect(parseWorkerUrl(output, "other")).toBeNull();
    expect(parseWorkerUrl("no address here", "viewcode-relay")).toBeNull();
  });
});

describe("isValidWorkerName", () => {
  it("accepts dns-label style names only", () => {
    expect(isValidWorkerName("viewcode-relay")).toBe(true);
    expect(isValidWorkerName("a")).toBe(true);
    for (const name of ["", "-x", "x-", "Upper", "has space", "a.b", "x".repeat(64)]) {
      expect(isValidWorkerName(name)).toBe(false);
    }
  });
});

describe("generateHostSecret", () => {
  it("is long, URL-safe and different every time", () => {
    const first = generateHostSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generateHostSecret()).not.toBe(first);
  });
});

describe("settings.json edits", () => {
  it("adds and removes the relay entry and keeps everything else", () => {
    const original = { providerSelection: "chosen", providers: { cursor: { enabled: true } } };
    const added = withRelaySettings(original, "https://r.a.workers.dev");
    expect(added).toEqual({
      ...original,
      viewcodeRelay: { enabled: true, url: "https://r.a.workers.dev" },
    });
    expect(withoutRelaySettings(added)).toEqual(original);
    expect(original).not.toHaveProperty("viewcodeRelay");
  });

  it("reads comments and trailing commas the way the server does, and refuses non-objects", () => {
    const dir = makeStateDir();
    const file = NodePath.join(dir, "settings.json");
    NodeFS.writeFileSync(file, '{\n // note\n "a": "// not a comment", "b": [1,2,],\n}\n');
    expect(readSettingsFile(file)).toEqual({ a: "// not a comment", b: [1, 2] });
    NodeFS.writeFileSync(file, "[1]");
    expect(() => readSettingsFile(file)).toThrow(/not a JSON object/u);
    expect(readSettingsFile(NodePath.join(dir, "missing.json"))).toEqual({});
    expect(parseLenientJson("{}")).toEqual({});
  });

  it("writes settings atomically, readable only by the owner", () => {
    const dir = makeStateDir();
    const file = NodePath.join(dir, "settings.json");
    writeSettingsFile(file, { viewcodeRelay: { enabled: true, url: "https://x" } });
    expect(readSettingsFile(file)).toEqual({ viewcodeRelay: { enabled: true, url: "https://x" } });
    expect(NodeFS.statSync(file).mode & 0o077).toBe(0);
    expect(NodeFS.readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("secret and state files", () => {
  it("stores the secret where the server's secret store reads it, owner-only", () => {
    const dir = makeStateDir();
    writeSecretFile(dir, "s3cret-value");
    const file = secretFilePath(dir);
    expect(file).toBe(NodePath.join(dir, "secrets", "viewcode-relay-host-secret.bin"));
    expect(NodeFS.readFileSync(file, "utf8")).toBe("s3cret-value");
    expect(NodeFS.statSync(file).mode & 0o077).toBe(0);
    expect(NodeFS.statSync(NodePath.dirname(file)).mode & 0o077).toBe(0);
    expect(readSecretFile(dir)).toBe("s3cret-value");
    removeSecretFile(dir);
    expect(readSecretFile(dir)).toBeNull();
  });

  it("remembers the worker name and address for remove", () => {
    const dir = makeStateDir();
    expect(readRelayState(dir)).toBeNull();
    writeRelayState(dir, { name: "viewcode-relay", url: "https://r.a.workers.dev" });
    expect(readRelayState(dir)).toEqual({ name: "viewcode-relay", url: "https://r.a.workers.dev" });
    removeRelayState(dir);
    expect(readRelayState(dir)).toBeNull();
  });
});

describe("wranglerNeedsLogin", () => {
  it("asks for login only when wrangler says nobody is signed in", () => {
    expect(wranglerNeedsLogin("You are not authenticated. Please run `wrangler login`.", 0)).toBe(
      true,
    );
    expect(wranglerNeedsLogin("", 1)).toBe(true);
    expect(
      wranglerNeedsLogin(
        "You are logged in with an OAuth Token, associated with the email x@y.z.",
        0,
      ),
    ).toBe(false);
  });
});
