import { describe, expect, it } from "vite-plus/test";

import {
  resolveDesktopAppControlAddress,
  resolveDesktopBackendListenPath,
} from "./desktopAppControl.ts";

describe("resolveDesktopAppControlAddress", () => {
  it("keeps Unix socket paths short and separates desktop state directories", () => {
    const first = resolveDesktopAppControlAddress({
      stateDir: `/home/user/${"long/".repeat(40)}userdata`,
      platform: "linux",
      tempDir: "/tmp",
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });
    const second = resolveDesktopAppControlAddress({
      stateDir: "/home/user/.t3/other/userdata",
      platform: "linux",
      tempDir: "/tmp",
      userId: 1000,
      joinPath: (...segments) => segments.join("/"),
    });

    expect(first.directory).toBe("/tmp/t3code-1000");
    expect(first.address.length).toBeLessThan(108);
    expect(first.address).not.toBe(second.address);
  });

  it("uses a Windows named pipe", () => {
    const result = resolveDesktopAppControlAddress({
      stateDir: "C:\\Users\\user\\.t3\\userdata",
      platform: "win32",
      tempDir: "C:\\Temp",
      userId: undefined,
      joinPath: (...segments) => segments.join("\\"),
    });

    expect(result.directory).toBeNull();
    expect(result.address).toMatch(/^\\\\\.\\pipe\\t3code-app-[a-f0-9]{24}$/);
  });
});

describe("resolveDesktopBackendListenPath", () => {
  const base = {
    tempDir: "/tmp",
    userId: 1000,
    nonce: "0123456789abcdef",
    joinPath: (...segments: readonly string[]) => segments.join("/"),
  };

  it("puts the backend socket beside the control socket, within Unix path limits", () => {
    const stateDir = `/home/user/${"long/".repeat(40)}userdata`;
    const listenPath = resolveDesktopBackendListenPath({ ...base, stateDir, platform: "darwin" });
    const control = resolveDesktopAppControlAddress({ ...base, stateDir, platform: "darwin" });
    expect(listenPath.startsWith(`${control.directory}/`)).toBe(true);
    expect(listenPath).not.toBe(control.address);
    expect(listenPath.length).toBeLessThan(104);
  });

  it("gives Windows a per-launch pipe name another account cannot predict", () => {
    const listenPath = resolveDesktopBackendListenPath({
      ...base,
      stateDir: "C:\\Users\\user\\.t3\\userdata",
      platform: "win32",
    });
    expect(listenPath).toMatch(/^\\\\\.\\pipe\\t3code-backend-[0-9a-f]+-0123456789abcdef$/);
  });
});
