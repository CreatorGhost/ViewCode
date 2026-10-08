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
 * The on-screen windows of the current desktop, front to back (pid, layer,
 * alpha, number, bounds), plus whether Screen Recording is granted (checked
 * without prompting). `planWindowCapture` decides from it.
 */
const ON_SCREEN_WINDOWS_SCRIPT = `ObjC.import("CoreGraphics");
function run() {
  var granted = typeof $.CGPreflightScreenCaptureAccess === "function" ? $.CGPreflightScreenCaptureAccess() : true;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var windows = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i], b = w.kCGWindowBounds;
    if (!b) continue;
    windows.push([w.kCGWindowOwnerPID, w.kCGWindowLayer, w.kCGWindowAlpha === undefined ? 1 : w.kCGWindowAlpha, w.kCGWindowNumber, b.X, b.Y, b.Width, b.Height]);
  }
  return JSON.stringify({ granted: granted, windows: windows });
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

export interface QuartzWindow {
  readonly pid: number;
  readonly layer: number;
  readonly alpha: number;
  readonly id: number;
  readonly bounds: Rect;
}

type QuartzRow = [number, number, number, number, number, number, number, number];

const isQuartzRow = (row: unknown): row is QuartzRow =>
  Array.isArray(row) && row.length === 8 && row.every((cell) => Number.isFinite(cell));

const parseQuartzWindows = (value: unknown): ReadonlyArray<QuartzWindow> =>
  Array.isArray(value)
    ? value.filter(isQuartzRow).map(([pid, layer, alpha, id, x, y, width, height]) => ({
        pid,
        layer,
        alpha,
        id,
        bounds: { x, y, width, height },
      }))
    : [];

const sameRect = (left: Rect, right: Rect) =>
  Math.abs(left.x - right.x) <= 1 &&
  Math.abs(left.y - right.y) <= 1 &&
  Math.abs(left.width - right.width) <= 1 &&
  Math.abs(left.height - right.height) <= 1;

const overlaps = (left: Rect, right: Rect) =>
  left.x < right.x + right.width &&
  right.x < left.x + left.width &&
  left.y < right.y + right.height &&
  right.y < left.y + left.height;

/**
 * How to capture an app's window at `bounds` from the current desktop's
 * on-screen windows (front to back). Null when there is no single such
 * window. `region`: nothing from another app overlaps it, so the screen at
 * its bounds is its own pixels plus the app's menus and popovers on top, at
 * the window's exact geometry. `window`: another app covers part of it, so
 * only its own pixels are captured, without its menus.
 */
export const planWindowCapture = (
  windows: ReadonlyArray<QuartzWindow>,
  pid: number,
  bounds: Rect,
): { readonly kind: "region" | "window"; readonly id: number } | null => {
  const matches = windows.filter(
    (window) => window.pid === pid && window.layer === 0 && sameRect(window.bounds, bounds),
  );
  if (matches.length !== 1) return null;
  const target = matches[0]!;
  const covered = windows
    .slice(0, windows.indexOf(target))
    .some((window) => window.pid !== pid && window.alpha > 0 && overlaps(window.bounds, bounds));
  return { kind: covered ? "window" : "region", id: target.id };
};

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

const readOnScreenWindows = async () => {
  const reply = JSON.parse(await jxa(ON_SCREEN_WINDOWS_SCRIPT, [], 5_000)) as {
    readonly granted?: unknown;
    readonly windows?: unknown;
  };
  if (reply.granted === false) throw permissionDenied();
  return parseQuartzWindows(reply.windows);
};

/**
 * Captures the window as the agent would act on it, scaled so its longest
 * edge is at most `maxSize`, with the image covering exactly `bounds`. When
 * no other app overlaps it, that is the screen at its bounds, so open menus
 * and popovers show; the plan is read again afterwards and the image dropped
 * if another app's window arrived meanwhile. When another app covers part of
 * it, only its own pixels (`screencapture -l -a`; attached windows would
 * stretch the image past `bounds`). Null when the window has no single
 * on-screen Quartz window at these bounds (minimized, another Space, or two
 * at the same spot); the caller must refuse rather than return another
 * window's pixels.
 */
export const macCaptureWindow = async (
  pid: number,
  bounds: Rect,
  outputPath: string,
  maxSize: number,
): Promise<{ readonly width: number; readonly height: number } | null> => {
  const plan = planWindowCapture(await readOnScreenWindows(), pid, bounds);
  if (!plan) return null;
  const fullPath = `${outputPath}.window.png`;
  await NodeFSP.mkdir(NodePath.dirname(outputPath), { recursive: true });
  const rect = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(",");
  const shoot = (kind: "region" | "window") =>
    run(
      SCREENCAPTURE,
      kind === "region"
        ? ["-x", "-t", "png", `-R${rect}`, fullPath]
        : ["-x", "-o", "-a", "-t", "png", `-l${plan.id}`, fullPath],
      10_000,
    );
  try {
    await shoot(plan.kind);
    if (plan.kind === "region") {
      const after = planWindowCapture(await readOnScreenWindows(), pid, bounds);
      if (after?.id !== plan.id) return null;
      // Another app's window arrived during the capture: its own pixels only.
      if (after.kind === "window") await shoot("window");
    }
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
