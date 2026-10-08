// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - owned by the plain Node driver worker.
/** Experimental process-directed input. No HID posts, activation or real pointer movement. */
import * as NodeChildProcess from "node:child_process";
import type { Rect } from "@crowecawcaw/xa11y";
import type { DriverPoint } from "./ComputerDriver.ts";

export type BackgroundInput =
  | {
      readonly kind: "click";
      readonly point: DriverPoint;
      readonly button: "left" | "right" | "middle";
      readonly count: number;
    }
  | {
      readonly kind: "scroll";
      readonly point: DriverPoint;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly kind: "key"; readonly keys: string };

/** Physical key codes. Unmapped chords refuse rather than send to the front app. */
const KEY_CODES: Readonly<Record<string, number>> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "9": 25,
  "7": 26,
  "8": 28,
  "0": 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  enter: 36,
  return: 36,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
  tab: 48,
  space: 49,
  backspace: 51,
  escape: 53,
  delete: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
const MODIFIERS: Readonly<Record<string, number>> = {
  cmd: 1 << 20,
  meta: 1 << 20,
  super: 1 << 20,
  shift: 1 << 17,
  ctrl: 1 << 18,
  alt: 1 << 19,
  option: 1 << 19,
};
export const backgroundKey = (keys: string) => {
  const parts = keys.split("+");
  const code = KEY_CODES[parts.pop() ?? ""];
  if (code === undefined || parts.some((part) => MODIFIERS[part] === undefined)) return null;
  return { code, flags: parts.reduce((flags, part) => flags | MODIFIERS[part]!, 0) };
};

const SCRIPT = `ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("Carbon");
function state() {
  var p = $.CGEventGetLocation($.CGEventCreate(null));
  return { front: Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier), x: p.x, y: p.y };
}
var posted = false;
function execute(r) {
  posted = false;
  if (r.input.kind === "foreground") return Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  var rows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var matches = rows.filter(function(w) {
    var b = w.kCGWindowBounds;
    return w.kCGWindowOwnerPID === r.pid && w.kCGWindowLayer === 0 && b &&
      b.X === r.bounds.x && b.Y === r.bounds.y && b.Width === r.bounds.width && b.Height === r.bounds.height;
  });
  if (matches.length !== 1) throw Error("window-unavailable");
  var windowId = matches[0].kCGWindowNumber;
  if (r.input.kind === "key" && (typeof $.IsSecureEventInputEnabled !== "function" || $.IsSecureEventInputEnabled())) throw Error("secure-input-unavailable");
  if (r.input.kind === "key" && (ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0))) || []).filter(function(w) {return w.kCGWindowOwnerPID === r.pid && w.kCGWindowLayer === 0;}).length !== 1) throw Error("ambiguous-key-window");
  var before = state(), source = $.CGEventSourceCreate(1);
  var point = r.input.point || { x: r.bounds.x + r.bounds.width / 2, y: r.bounds.y + r.bounds.height / 2 };
  function post(e, count) {
    $.CGEventSetIntegerValueField(e, 40, r.pid);
    $.CGEventSetIntegerValueField(e, 51, windowId);
    $.CGEventSetIntegerValueField(e, 58, 1);
    $.CGEventSetIntegerValueField(e, 91, windowId);
    $.CGEventSetIntegerValueField(e, 92, windowId);
    $.CGEventSetIntegerValueField(e, 1, count || 1);
    if (typeof $.CGEventSetWindowLocation === "function") $.CGEventSetWindowLocation(e, {x: point.x - r.bounds.x, y: point.y - r.bounds.y});
    posted = true;
    $.CGEventPostToPid(r.pid, e);
  }
  if (r.input.kind === "click") {
    var button = r.input.button === "right" ? 1 : r.input.button === "middle" ? 2 : 0;
    post($.CGEventCreateMouseEvent(source, 5, point, button), 1);
    for (var i = 1; i <= r.input.count; i++) {
      post($.CGEventCreateMouseEvent(source, button === 0 ? 1 : button === 1 ? 3 : 25, point, button), i);
      post($.CGEventCreateMouseEvent(source, button === 0 ? 2 : button === 1 ? 4 : 26, point, button), i);
    }
  } else if (r.input.kind === "scroll") {
    var e = $.CGEventCreateScrollWheelEvent(source, 0, 2, r.input.dy, r.input.dx);
    $.CGEventSetLocation(e, point); post(e);
  } else if (r.input.kind === "key") {
    [true, false].forEach(function(down) {
      var e = $.CGEventCreateKeyboardEvent(source, r.key.code, down);
      $.CGEventSetFlags(e, r.key.flags); post(e);
    });
  }
  var after = state();
  return { tookFocus: before.front !== after.front, pointerMoved: before.x !== after.x || before.y !== after.y };
}
function output(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
function run() {
  var pending = "";
  while (true) {
    var data = $.NSFileHandle.fileHandleWithStandardInput.availableData;
    if (Number(data.length) === 0) break;
    pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var lines = pending.split("\\n"); pending = lines.pop();
    lines.forEach(function(line) {
      var r;
      posted = false;
      try { r = JSON.parse(line); output({ id: r.id, ok: true, result: execute(r) }); }
      catch (e) { output({ id: r && r.id, ok: false, dispatched: posted, reason: String(e) }); }
    });
  }
}`;

export class BackgroundInputError extends Error {
  readonly dispatched: boolean;
  constructor(message: string, dispatched: boolean) {
    super(message);
    this.name = "BackgroundInputError";
    this.dispatched = dispatched;
  }
}
const refused = (message: string, dispatched = false) =>
  new BackgroundInputError(message, dispatched);

/** One helper per driver lifetime; EOF from a dead driver also stops it. */
export const makeMacBackgroundInput = () => {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let nextId = 0;
  let pending:
    | { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  let buffered = "";
  const close = () => {
    const owned = child;
    child = undefined;
    owned?.stdin.end();
    owned?.kill();
    pending?.reject(refused("The background input helper stopped.", true));
    pending = undefined;
    buffered = "";
  };
  const post = (
    pid: number,
    bounds: Rect,
    input: BackgroundInput | { readonly kind: "foreground" },
  ) =>
    new Promise<void | number>((resolve, reject) => {
      const key = input.kind === "key" ? backgroundKey(input.keys) : undefined;
      if (key === null)
        return reject(
          refused(
            "This shortcut is not supported by background input. Use a ref or explicitly focus the window first.",
          ),
        );
      child ??= NodeChildProcess.spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const owned = child;
      if (owned.stdout.listenerCount("data") === 0) {
        // stdout owns the parser; listeners are installed only on a fresh process.
        owned.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            let reply: unknown;
            try {
              reply = JSON.parse(line);
            } catch {
              pending?.reject(
                refused("The background input helper returned an invalid reply.", true),
              );
              close();
              return;
            }
            if (
              typeof reply !== "object" ||
              reply === null ||
              !("id" in reply) ||
              reply.id !== pending?.id
            )
              continue;
            pending?.resolve(reply);
          }
        });
        owned.stderr.resume();
        owned.once("error", () => {
          if (child === owned) close();
        });
        owned.once("exit", () => {
          if (child === owned) close();
        });
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        reject(refused("Background input timed out; its effect is unknown.", true));
        close();
      }, 5_000);
      pending = {
        id,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          pending = undefined;
          if (
            typeof value !== "object" ||
            value === null ||
            !("ok" in value) ||
            value.ok !== true
          ) {
            const dispatched =
              typeof value !== "object" ||
              value === null ||
              !("dispatched" in value) ||
              value.dispatched !== false;
            const secure =
              typeof value === "object" &&
              value !== null &&
              "reason" in value &&
              String(value.reason).includes("secure-input-unavailable");
            reject(
              refused(
                secure
                  ? "Background shortcuts are unavailable while Secure Event Input is active or its state cannot be checked. No key was posted."
                  : "Background input could not address this exact current-desktop window. Process-scoped shortcuts require one document window. Observe again before retrying.",
                dispatched,
              ),
            );
            return;
          }
          const result = "result" in value ? value.result : undefined;
          if (input.kind === "foreground") {
            if (typeof result === "number" && Number.isInteger(result) && result > 0)
              resolve(result);
            else reject(refused("The front application could not be read."));
            return;
          }
          if (
            typeof result !== "object" ||
            result === null ||
            !("tookFocus" in result) ||
            typeof result.tookFocus !== "boolean" ||
            !("pointerMoved" in result) ||
            typeof result.pointerMoved !== "boolean"
          ) {
            reject(refused("The background input helper returned an invalid reply.", true));
            return;
          }
          if (result.tookFocus || result.pointerMoved) {
            reject(
              refused(
                "The foreground app or real pointer changed during background input. Stop and observe again; the input may have landed.",
                true,
              ),
            );
            return;
          }
          resolve();
        },
      };
      owned.stdin.write(`${JSON.stringify({ id, pid, bounds, input, key })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          reject(refused("The background input helper disconnected.", true));
          close();
        }
      });
    });
  return {
    close,
    // AXFocusedApplication can keep pointing at an inactive app after its
    // context menu opens. NSWorkspace reports the app that owns the screen.
    foregroundPid: async () => {
      const pid = await post(0, { x: 0, y: 0, width: 0, height: 0 }, { kind: "foreground" });
      return typeof pid === "number" ? pid : null;
    },
    dispatch: async (
      pid: number,
      bounds: Rect,
      input: BackgroundInput,
      authorize: () => Promise<void>,
    ) => {
      await authorize();
      await post(pid, bounds, input);
    },
  };
};
