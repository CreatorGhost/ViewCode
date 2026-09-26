import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";

import * as WindowGlass from "./WindowGlass.ts";
import { WINDOW_GLASS_STATE_CHANNEL } from "./windowGlassChannels.ts";

function makeFakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setVibrancy: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    setBackgroundColor: vi.fn(),
    webContents: { send: vi.fn() },
  };
}

afterEach(() => {
  WindowGlass.setWindowGlassEnabled(true);
});

describe("resolveWindowGlassMaterial", () => {
  it("uses vibrancy on macOS and Mica only from Windows 11 22H2", () => {
    expect(WindowGlass.resolveWindowGlassMaterial("darwin", "24.0.0")).toBe("vibrancy");
    expect(WindowGlass.resolveWindowGlassMaterial("win32", "10.0.22631")).toBe("mica");
    expect(WindowGlass.resolveWindowGlassMaterial("win32", "10.0.22621")).toBe("mica");
    expect(WindowGlass.resolveWindowGlassMaterial("win32", "10.0.22000")).toBeNull();
    expect(WindowGlass.resolveWindowGlassMaterial("win32", "10.0.19045")).toBeNull();
    expect(WindowGlass.resolveWindowGlassMaterial("win32", "garbage")).toBeNull();
    expect(WindowGlass.resolveWindowGlassMaterial("linux", "6.8.0")).toBeNull();
  });
});

describe("window glass on macOS", () => {
  it("opens a see-through window by default", () => {
    expect(WindowGlass.getWindowGlassState("darwin")).toEqual({
      supported: true,
      enabled: true,
      active: true,
    });
    expect(WindowGlass.windowGlassConstructorOptions("darwin")).toEqual({
      vibrancy: "under-window",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
    });
  });

  it("turns vibrancy off and back on in a live window and tells the renderer", () => {
    const window = makeFakeWindow();
    WindowGlass.setWindowGlassEnabled(false);
    const off = WindowGlass.syncWindowGlass(
      window as unknown as Electron.BrowserWindow,
      "darwin",
      "#1F1F21",
    );
    expect(off).toEqual({ supported: true, enabled: false, active: false });
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1F1F21");
    expect(window.webContents.send).toHaveBeenLastCalledWith(WINDOW_GLASS_STATE_CHANNEL, off);
    expect(WindowGlass.windowGlassConstructorOptions("darwin")).toEqual({});

    WindowGlass.setWindowGlassEnabled(true);
    WindowGlass.syncWindowGlass(window as unknown as Electron.BrowserWindow, "darwin", "#1F1F21");
    expect(window.setVibrancy).toHaveBeenLastCalledWith("under-window");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
  });
});

describe("window glass on Linux", () => {
  it("stays opaque and leaves the window alone apart from its colour", () => {
    const window = makeFakeWindow();
    expect(WindowGlass.getWindowGlassState("linux").active).toBe(false);
    expect(WindowGlass.windowGlassConstructorOptions("linux")).toEqual({});
    WindowGlass.syncWindowGlass(window as unknown as Electron.BrowserWindow, "linux", "#EDEDEF");
    expect(window.setVibrancy).not.toHaveBeenCalled();
    expect(window.setBackgroundMaterial).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).toHaveBeenCalledWith("#EDEDEF");
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
