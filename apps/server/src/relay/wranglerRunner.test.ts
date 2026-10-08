import { describe, expect, it } from "@effect/vitest";

import { chooseNpx, wranglerCommand, wranglerEnvironment } from "./wranglerRunner.ts";

describe("chooseNpx", () => {
  it("keeps the system npx whenever its Node is recent enough, desktop or not", () => {
    const system = { kind: "system", nodeVersion: [22, 15] };
    expect(chooseNpx({ systemNode: "v22.15.1\n", desktopNodeVersion: null })).toEqual(system);
    expect(chooseNpx({ systemNode: "v22.15.1\n", desktopNodeVersion: "24.11.1" })).toEqual(system);
  });

  it("uses the bundled npm under the desktop app when there is no usable Node", () => {
    const bundled = { kind: "bundled", nodeVersion: [24, 11] };
    expect(chooseNpx({ systemNode: null, desktopNodeVersion: "24.11.1" })).toEqual(bundled);
    // An installed Node too old for wrangler does not stop the desktop.
    expect(chooseNpx({ systemNode: "v18.19.0", desktopNodeVersion: "24.11.1" })).toEqual(bundled);
  });

  it("asks for Node.js outside the desktop app, as before", () => {
    expect(chooseNpx({ systemNode: null, desktopNodeVersion: null })).toEqual({ kind: "missing" });
    expect(chooseNpx({ systemNode: "v18.19.0\n", desktopNodeVersion: null })).toEqual({
      kind: "system-too-old",
      found: "v18.19.0",
    });
  });

  it("refuses an Electron whose Node is too old for wrangler", () => {
    expect(chooseNpx({ systemNode: null, desktopNodeVersion: "20.18.0" })).toEqual({
      kind: "desktop-too-old",
      nodeVersion: "20.18.0",
    });
  });
});

describe("wranglerCommand", () => {
  it("runs the system npx by name, or the bundled npx-cli.js under this executable", () => {
    expect(wranglerCommand({ kind: "system" }, ["whoami", "--json"])).toEqual({
      command: "npx",
      args: ["--yes", "wrangler@4", "whoami", "--json"],
    });
    const executable = "C:\\Program Files\\ViewCode\\ViewCode.exe";
    const npxCli = "C:\\Users\\Jo Doe\\.t3\\caches\\npm-11.20.0\\bin\\npx-cli.js";
    // Paths with spaces stay single arguments: the executable is spawned without a shell.
    expect(wranglerCommand({ kind: "bundled", executable, npxCli }, ["deploy"])).toEqual({
      command: executable,
      args: [npxCli, "--yes", "wrangler@4", "deploy"],
    });
  });
});

describe("wranglerEnvironment", () => {
  it("trusts the system CA store and keeps the proxy settings it was given", () => {
    const env = wranglerEnvironment({
      env: {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy:8080",
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      nodeVersion: [22, 15],
      platform: "linux",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
      NODE_OPTIONS: "--use-system-ca --max-old-space-size=4096",
      WRANGLER_SEND_METRICS: "false",
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("puts the node shim first on PATH and runs Electron as Node for the bundled npm", () => {
    expect(
      wranglerEnvironment({
        env: { PATH: "/usr/bin:/bin" },
        nodeVersion: [24, 11],
        platform: "darwin",
        shimDir: "/tmp/viewcode-node-x",
      }),
    ).toMatchObject({
      PATH: "/tmp/viewcode-node-x:/usr/bin:/bin",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--use-system-ca",
    });
    // Windows keeps its own spelling of the key and its own delimiter.
    const windows = wranglerEnvironment({
      env: { Path: "C:\\Windows\\system32" },
      nodeVersion: [24, 11],
      platform: "win32",
      shimDir: "C:\\Temp\\viewcode-node-x",
    });
    expect(windows.Path).toBe("C:\\Temp\\viewcode-node-x;C:\\Windows\\system32");
    expect(windows.PATH).toBeUndefined();
  });
});
