// @effect-diagnostics nodeBuiltinImport:off - runs inside the plain Node driver worker, outside the Effect runtime.
/**
 * macOS input and capture the driver cannot get from xa11y, done through
 * system tools only (`osascript` JavaScript for Automation, `screencapture`,
 * `sips`), so nothing has to be compiled on the user's Mac. They are child
 * processes of the driver, which macOS treats as part of the app, so they
 * use the app's Accessibility and Screen Recording grants.
 *
 * Every argument is passed as argv to an absolute system path, never through
 * a shell, and the scripts are constants.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { Rect } from "@crowecawcaw/xa11y";

import type { DriverPoint } from "./ComputerDriver.ts";

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";

/** Interpolated mouse-dragged events: 20 steps over half a second. */
const DRAG_STEPS = 20;
const DRAG_STEP_MS = 25;

/**
 * A left-button drag as positioned Quartz events: move, down, dragged steps,
 * up. xa11y 0.13 posts its macOS mouse down and up at (0,0) instead of at the
 * pointer, so its own drag presses the screen corner. Events come from a
 * HID-state source after the real cursor is moved to the start, because
 * WebKit and Chromium filter drags that do not look like hardware input; the
 * pauses let apps such as Blender register the press before the motion. The
 * button is released even when a later event fails.
 */
const DRAG_SCRIPT = `ObjC.import("CoreGraphics");
function run(argv) {
  var n = argv.map(Number);
  var from = { x: n[0], y: n[1] }, to = { x: n[2], y: n[3] };
  var steps = n[4], pause = n[5] / 1000;
  var source = $.CGEventSourceCreate(1);
  function post(type, point) {
    var event = $.CGEventCreateMouseEvent(source, type, point, 0);
    if (type === 1 || type === 2) $.CGEventSetIntegerValueField(event, 1, 1);
    $.CGEventPost(0, event);
  }
  $.CGWarpMouseCursorPosition(from);
  post(5, from);
  delay(0.03);
  post(5, from);
  delay(0.05);
  post(1, from);
  try {
    delay(0.05);
    for (var i = 1; i <= steps; i++) {
      post(6, { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
      delay(pause);
    }
  } finally {
    post(2, to);
  }
  return "ok";
}`;

/**
 * Asks a Chromium or Electron app to build its accessibility tree, which it
 * otherwise only does for screen readers, so its web content has controls to
 * observe. Prints the AXError (0 = accepted). AXEnhancedUserInterface would
 * also work but changes how other apps animate and resize windows.
 */
const MANUAL_ACCESSIBILITY_SCRIPT = `ObjC.import("ApplicationServices");
function run(argv) {
  var app = $.AXUIElementCreateApplication(Number(argv[0]));
  var name = $("AXManualAccessibility");
  var value = $.kCFBooleanTrue || $.NSNumber.numberWithBool(true);
  try {
    return String($.AXUIElementSetAttributeValue(app, name, value));
  } catch (error) {
    return String($.AXUIElementSetAttributeValue(app, ObjC.castObjectToRef(name), ObjC.castObjectToRef(value)));
  }
}`;

/**
 * Seconds since the last mouse or keyboard event from the hardware event
 * system (kCGAnyInputEventType). Events the driver posts may count too; the
 * driver tells them apart by when its own input ended.
 */
const SECONDS_SINCE_INPUT_SCRIPT = `ObjC.import("CoreGraphics");
function run() {
  return String($.CGEventSourceSecondsSinceLastEventType(1, 4294967295));
}`;

/** Releases the left button wherever the pointer is now. */
const RELEASE_SCRIPT = `ObjC.import("CoreGraphics");
function run() {
  var at = $.CGEventGetLocation($.CGEventCreate(null));
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 2, at, 0));
  return "ok";
}`;

/**
 * The Quartz window numbers of an app's on-screen, normal-layer windows at
 * exactly these bounds, plus whether Screen Recording is granted (checked
 * without prompting).
 */
const WINDOW_NUMBERS_SCRIPT = `ObjC.import("CoreGraphics");
function run(argv) {
  var n = argv.map(Number);
  var granted = typeof $.CGPreflightScreenCaptureAccess === "function" ? $.CGPreflightScreenCaptureAccess() : true;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var ids = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i], b = w.kCGWindowBounds;
    if (w.kCGWindowOwnerPID !== n[0] || w.kCGWindowLayer !== 0 || !b) continue;
    if (Math.abs(b.X - n[1]) <= 1 && Math.abs(b.Y - n[2]) <= 1 && Math.abs(b.Width - n[3]) <= 1 && Math.abs(b.Height - n[4]) <= 1) {
      ids.push(w.kCGWindowNumber);
    }
  }
  return JSON.stringify({ granted: granted, ids: ids });
}`;

const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const jxa = (script: string, args: ReadonlyArray<string | number>, timeoutMs: number) =>
  run(OSASCRIPT, ["-l", "JavaScript", "-e", script, ...args.map(String)], timeoutMs);

const coordinate = (value: number) => String(Math.round(value * 100) / 100);

/** True when the app accepted `AXManualAccessibility`, so its tree is being built. */
export const macEnableManualAccessibility = async (pid: number): Promise<boolean> =>
  (await jxa(MANUAL_ACCESSIBILITY_SCRIPT, [pid], 5_000)).trim() === "0";

/** Null when the answer is not a number. */
export const macSecondsSinceInput = async (): Promise<number | null> => {
  const seconds = Number((await jxa(SECONDS_SINCE_INPUT_SCRIPT, [], 5_000)).trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

export const macReleaseMouse = async (): Promise<void> => {
  await jxa(RELEASE_SCRIPT, [], 5_000);
};

export const macDrag = async (from: DriverPoint, to: DriverPoint): Promise<void> => {
  try {
    await jxa(
      DRAG_SCRIPT,
      [from.x, from.y, to.x, to.y]
        .map(coordinate)
        .concat([String(DRAG_STEPS), String(DRAG_STEP_MS)]),
      5_000 + DRAG_STEPS * DRAG_STEP_MS,
    );
  } catch (error) {
    // A script killed mid-drag (timeout) never reached its own release.
    await macReleaseMouse().catch(() => undefined);
    throw error;
  }
};

/** Width and height from a PNG's IHDR chunk. */
export const pngDimensions = (bytes: Uint8Array): { width: number; height: number } | null => {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const permissionDenied = () =>
  Object.assign(new Error("Screen Recording is not granted."), { name: "PermissionDeniedError" });

/** Reject extra capture extent that cannot share the window's coordinate mapping. */
export const captureMatchesBounds = (
  size: { readonly width: number; readonly height: number },
  bounds: Rect,
): boolean =>
  bounds.width > 0 &&
  bounds.height > 0 &&
  size.width > 0 &&
  size.height > 0 &&
  Math.abs(size.height - (size.width * bounds.height) / bounds.width) <= 2;

/**
 * Captures only the window's own pixels, even where other windows cover it,
 * scaled so its longest edge is at most `maxSize`. Null when the window has
 * no single on-screen Quartz window at these bounds (minimized, another
 * Space, or two at the same spot); the caller must refuse rather than return
 * another window's pixels from a screen-region capture.
 */
export const macCaptureWindow = async (
  pid: number,
  bounds: Rect,
  outputPath: string,
  maxSize: number,
): Promise<{ readonly width: number; readonly height: number } | null> => {
  const reply = JSON.parse(
    await jxa(
      WINDOW_NUMBERS_SCRIPT,
      [pid, bounds.x, bounds.y, bounds.width, bounds.height].map(coordinate),
      5_000,
    ),
  ) as { readonly granted?: unknown; readonly ids?: unknown };
  if (reply.granted === false) throw permissionDenied();
  const ids = Array.isArray(reply.ids) ? reply.ids.filter(Number.isSafeInteger) : [];
  if (ids.length !== 1) return null;
  const fullPath = `${outputPath}.window.png`;
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  try {
    // Attached menus extend the PNG outside the AX window bounds, changing
    // its pixel-to-screen mapping. Capture the window alone, without them.
    await run(SCREENCAPTURE, ["-x", "-o", "-a", "-t", "png", `-l${ids[0]}`, fullPath], 10_000);
    const full = pngDimensions(await NodeFSP.readFile(fullPath));
    if (!full || !captureMatchesBounds(full, bounds)) return null;
    if (Math.max(full.width, full.height) > maxSize) {
      await run(SIPS, ["-Z", String(maxSize), fullPath, "--out", outputPath], 10_000);
    } else {
      await NodeFSP.rename(fullPath, outputPath);
    }
    return pngDimensions(await NodeFSP.readFile(outputPath));
  } finally {
    await NodeFSP.rm(fullPath, { force: true });
  }
};
