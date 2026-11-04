// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { syncDocumentMacosWindowControls } from "./windowControlsOverlay";

function fakeBridge(fullscreen: boolean) {
  let listener: ((fullscreen: boolean) => void) | null = null;
  return {
    getWindowFullscreenState: () => fullscreen,
    onWindowFullscreenStateChange: (next: (fullscreen: boolean) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emit: (value: boolean) => listener?.(value),
  };
}

describe("syncDocumentMacosWindowControls", () => {
  afterEach(() => {
    delete document.documentElement.dataset.macosWindowControls;
  });

  it("marks the traffic lights visible on macOS and hidden in fullscreen", () => {
    const bridge = fakeBridge(false);
    const stop = syncDocumentMacosWindowControls("MacIntel", bridge);
    expect(document.documentElement.dataset.macosWindowControls).toBe("visible");

    bridge.emit(true);
    expect(document.documentElement.dataset.macosWindowControls).toBe("hidden");

    stop();
    expect(document.documentElement.dataset.macosWindowControls).toBeUndefined();
    bridge.emit(false);
    expect(document.documentElement.dataset.macosWindowControls).toBeUndefined();
  });

  it("leaves other platforms alone", () => {
    syncDocumentMacosWindowControls("Win32", fakeBridge(false));
    expect(document.documentElement.dataset.macosWindowControls).toBeUndefined();
  });
});
