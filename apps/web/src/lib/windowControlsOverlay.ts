import { isMacPlatform, isWindowsPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const ELECTRON_CLASS_NAME = "electron";
const ELECTRON_WINDOWS_CLASS_NAME = "electron-windows";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  update();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
  };
}

function getElectronPlatformClassNames(
  platform: string,
):
  | readonly [typeof ELECTRON_CLASS_NAME]
  | readonly [typeof ELECTRON_CLASS_NAME, typeof ELECTRON_WINDOWS_CLASS_NAME] {
  return isWindowsPlatform(platform)
    ? [ELECTRON_CLASS_NAME, ELECTRON_WINDOWS_CLASS_NAME]
    : [ELECTRON_CLASS_NAME];
}

export function syncDocumentElectronPlatformClasses(platform: string): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const classNames = getElectronPlatformClassNames(platform);
  document.documentElement.classList.add(...classNames);
  return () => {
    document.documentElement.classList.remove(...classNames);
  };
}

/**
 * The macOS traffic lights sit over the window's top-left corner. Marks the
 * root with `data-macos-window-controls="visible"` while they show (out of
 * fullscreen) so CSS keeps that corner clear (viewcode-theme.css). Setting the
 * attribute by hand in a plain browser previews the desktop layout.
 */
export function syncDocumentMacosWindowControls(
  platform: string,
  bridge: Pick<
    NonNullable<Window["desktopBridge"]>,
    "getWindowFullscreenState" | "onWindowFullscreenStateChange"
  > | null,
): () => void {
  if (typeof document === "undefined" || !isMacPlatform(platform)) {
    return () => {};
  }
  const root = document.documentElement;
  const update = (fullscreen: boolean) => {
    root.dataset.macosWindowControls = fullscreen ? "hidden" : "visible";
  };
  update(bridge?.getWindowFullscreenState?.() ?? false);
  const unsubscribe = bridge?.onWindowFullscreenStateChange?.(update);
  return () => {
    unsubscribe?.();
    delete root.dataset.macosWindowControls;
  };
}
