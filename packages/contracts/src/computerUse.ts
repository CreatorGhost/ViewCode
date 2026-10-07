/**
 * Computer use - the wire between the `viewcode-computer` CLI an agent runs
 * through its own shell tool and the environment server that owns the
 * desktop driver.
 *
 * Deliberately not MCP: managed machines block client-supplied MCP servers,
 * so the CLI is the agent-facing surface and the server is the only gate.
 * The server re-validates every request against these schemas; the CLI's own
 * argv checks only give the agent faster, friendlier errors.
 *
 * @module ComputerUse
 */
import { Schema } from "effect";

/**
 * `off`: no CLI, no instructions. `observe`: windows, element trees and
 * screenshots only. `control`: also input, each mutation gated by the
 * thread's runtime mode and approval.
 */
export const ComputerUseMode = Schema.Literals(["off", "observe", "control"]);
export type ComputerUseMode = typeof ComputerUseMode.Type;

/**
 * When input asks the user first. `thread`: follow the thread's permission
 * mode (Full access skips routine approvals). `risky`: only destructive-looking
 * actions ask, in any mode. `never`: nothing asks. The denylist and the pause
 * while any approval waits (`CU-CON-008`) apply in every case.
 */
export const ComputerUseApprovals = Schema.Literals(["thread", "risky", "never"]);
export type ComputerUseApprovals = typeof ComputerUseApprovals.Type;

/**
 * `CU-VAL-*` invalid request, `CU-NOT-*` unknown target, `CU-CON-*` refused by
 * policy or state, `CU-EXT-*` driver or OS, `CU-INT-*` a ViewCode bug.
 */
export const ComputerUseErrorCode = Schema.Literals([
  /** Unknown command. */
  "CU-VAL-001",
  /** Required argument missing. */
  "CU-VAL-002",
  /** Argument has the wrong type or is out of range. */
  "CU-VAL-003",
  /** Argument not accepted by this command. */
  "CU-VAL-004",
  /** Window id unknown to this thread (never listed, or closed). */
  "CU-NOT-001",
  /** Element ref unknown to this thread. */
  "CU-NOT-002",
  /** Screenshot (shot) id unknown to this thread. */
  "CU-NOT-003",
  /** Computer use is off on this server, or not granted to this session. */
  "CU-CON-001",
  /** Input requested while the server allows observation only. */
  "CU-CON-002",
  /** Ref is from an older observation, or the element changed since. */
  "CU-CON-003",
  /** The user declined the action, or no answer arrived. */
  "CU-CON-004",
  /** The target app is never controllable (password managers, ViewCode itself, ...). */
  "CU-CON-005",
  /** No turn is running in this thread; computer actions belong to a turn. */
  "CU-CON-006",
  /**
   * Coordinates come from a screenshot that is no longer the window's newest,
   * or the window moved, resized or closed since it was taken.
   */
  "CU-CON-007",
  /**
   * Input is paused while any approval in this environment waits for the user,
   * so an agent can never click an approval (in ViewCode, a browser tab or a
   * mirrored screen) for itself or another agent.
   */
  "CU-CON-008",
  /** Platform unsupported or the driver could not start. */
  "CU-EXT-001",
  /** Accessibility permission is missing for the app that runs ViewCode. */
  "CU-EXT-002",
  /** Screen Recording permission is missing (screenshots only). */
  "CU-EXT-003",
  /** The driver failed or timed out performing the action. */
  "CU-EXT-004",
  /** The driver answered with something that is not a valid result. */
  "CU-EXT-005",
  /** The CLI could not reach the ViewCode server. */
  "CU-EXT-006",
  /** Unexpected internal failure. */
  "CU-INT-001",
]);
export type ComputerUseErrorCode = typeof ComputerUseErrorCode.Type;

const WindowId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const ElementRef = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const ShortText = Schema.String.check(Schema.isMaxLength(200));
/** Typed and set text. Bounded so a runaway agent cannot paste a novel. */
const InputText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000));
/** `enter`, `cmd+shift+z`: modifiers joined by `+`, then exactly one key. */
export const COMPUTER_USE_KEY_PATTERN =
  /^(?:(?:cmd|ctrl|alt|shift|meta|option|super)\+){0,4}(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|enter|return|tab|escape|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown)$/;
const KeyChord = Schema.String.check(Schema.isPattern(COMPUTER_USE_KEY_PATTERN));
const ScrollDelta = Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }));
const ShotId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** Pixel in the screenshot image, from its top-left corner. Bounds are checked against the shot. */
const ImagePixel = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** Longest edge of the returned image. Vision models read about 1568px best. */
export const COMPUTER_USE_DEFAULT_SCREENSHOT_SIZE = 1568;
const ScreenshotMaxSize = Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 2560 }));
export const ComputerUseMouseButton = Schema.Literals(["left", "right", "middle"]);
export type ComputerUseMouseButton = typeof ComputerUseMouseButton.Type;

/** Body of `POST /api/computer-use`. One command per request. */
export const ComputerUseRequest = Schema.Union([
  Schema.Struct({ command: Schema.Literal("status") }),
  Schema.Struct({ command: Schema.Literal("list-windows"), app: Schema.optional(ShortText) }),
  Schema.Struct({
    command: Schema.Literal("observe"),
    window: WindowId,
    /** Case-insensitive substring over label and value; narrows a large tree. */
    query: Schema.optional(ShortText),
  }),
  Schema.Struct({
    command: Schema.Literal("screenshot"),
    window: WindowId,
    maxSize: Schema.optional(ScreenshotMaxSize),
  }),
  Schema.Struct({ command: Schema.Literal("press"), ref: ElementRef }),
  Schema.Struct({ command: Schema.Literal("set-value"), ref: ElementRef, value: InputText }),
  Schema.Struct({ command: Schema.Literal("type"), ref: ElementRef, text: InputText }),
  Schema.Struct({ command: Schema.Literal("key"), window: WindowId, keys: KeyChord }),
  Schema.Struct({
    command: Schema.Literal("scroll"),
    ref: ElementRef,
    dx: ScrollDelta,
    dy: ScrollDelta,
  }),
  // Coordinate (vision) commands: x/y are pixels in screenshot `shot`, which
  // must be the newest screenshot of its window. The server maps them to the
  // screen and refuses if the window moved since. They bring the window to
  // the front first, because synthetic pointer input lands on whatever is on top.
  Schema.Struct({
    command: Schema.Literal("click"),
    shot: ShotId,
    x: ImagePixel,
    y: ImagePixel,
    button: Schema.optional(ComputerUseMouseButton),
    count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }),
  Schema.Struct({
    command: Schema.Literal("drag"),
    shot: ShotId,
    fromX: ImagePixel,
    fromY: ImagePixel,
    toX: ImagePixel,
    toY: ImagePixel,
  }),
  Schema.Struct({ command: Schema.Literal("move"), shot: ShotId, x: ImagePixel, y: ImagePixel }),
  Schema.Struct({
    command: Schema.Literal("scroll-at"),
    shot: ShotId,
    x: ImagePixel,
    y: ImagePixel,
    dx: ScrollDelta,
    dy: ScrollDelta,
  }),
  /** Types into whatever has keyboard focus in the window (after bringing it to the front). */
  Schema.Struct({ command: Schema.Literal("type-focused"), window: WindowId, text: InputText }),
]);
export type ComputerUseRequest = typeof ComputerUseRequest.Type;
export type ComputerUseCommand = ComputerUseRequest["command"];

export const COMPUTER_USE_OBSERVATION_COMMANDS = [
  "status",
  "list-windows",
  "observe",
  "screenshot",
] as const satisfies ReadonlyArray<ComputerUseCommand>;

export const COMPUTER_USE_INPUT_COMMANDS = [
  "press",
  "set-value",
  "type",
  "key",
  "scroll",
  "click",
  "drag",
  "move",
  "scroll-at",
  "type-focused",
] as const satisfies ReadonlyArray<ComputerUseCommand>;

export const ComputerUseRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ComputerUseRect = typeof ComputerUseRect.Type;

export const ComputerUseWindow = Schema.Struct({
  id: WindowId,
  app: Schema.String,
  pid: Schema.Int,
  title: Schema.String,
  focused: Schema.Boolean,
  bounds: Schema.optional(ComputerUseRect),
});
export type ComputerUseWindow = typeof ComputerUseWindow.Type;

export const ComputerUseElement = Schema.Struct({
  ref: ElementRef,
  role: Schema.String,
  label: Schema.String,
  /** Clipped. Omitted for secure text fields. */
  value: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  focused: Schema.Boolean,
});
export type ComputerUseElement = typeof ComputerUseElement.Type;

/** Fresh, never cached: what the process that would act can do right now. */
export const ComputerUseStatus = Schema.Struct({
  mode: ComputerUseMode,
  platform: Schema.String,
  /** False with a reason when the driver cannot run on this machine. */
  driverAvailable: Schema.Boolean,
  accessibility: Schema.Literals(["granted", "denied", "unknown"]),
  /** Why something above is not available, worded for the user. */
  reason: Schema.optional(Schema.String),
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

/**
 * Input actions only. `dispatched`: the OS accepted it; it is not proof of
 * an effect, so the agent re-observes. A failure before dispatch reports
 * `not-dispatched` on the error instead.
 */
export const ComputerUseEffect = Schema.Literals([
  "dispatched",
  "not-dispatched",
  "dispatched-unknown",
]);
export type ComputerUseEffect = typeof ComputerUseEffect.Type;

const ComputerUseShotFields = {
  /** Id to pass as `shot` to coordinate commands. */
  shot: ShotId,
  window: WindowId,
  /** PNG on the server's disk, readable by the agent's file tools. */
  path: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
};

export const ComputerUseResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status"), status: ComputerUseStatus }),
  Schema.Struct({ kind: Schema.Literal("windows"), windows: Schema.Array(ComputerUseWindow) }),
  Schema.Struct({
    kind: Schema.Literal("observation"),
    window: WindowId,
    elements: Schema.Array(ComputerUseElement),
    /** True when the element cap cut the list; narrow with `query`. */
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("screenshot"), ...ComputerUseShotFields }),
  Schema.Struct({
    kind: Schema.Literal("input"),
    effect: Schema.Literal("dispatched"),
    /**
     * The window shortly after the action, when Screen Recording allows it.
     * Its `shot` is the one to use for the next coordinate command.
     */
    screenshot: Schema.optional(Schema.Struct(ComputerUseShotFields)),
  }),
]);
export type ComputerUseResult = typeof ComputerUseResult.Type;

export const ComputerUseError = Schema.Struct({
  code: ComputerUseErrorCode,
  message: Schema.String,
  /** Set for input commands; `dispatched-unknown` must never be replayed blindly. */
  effect: Schema.optional(ComputerUseEffect),
});
export type ComputerUseError = typeof ComputerUseError.Type;

/** What the CLI prints, one JSON line, exit 0 only for `ok: true`. */
export const ComputerUseResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: ComputerUseResult }),
  Schema.Struct({ ok: Schema.Literal(false), error: ComputerUseError }),
]);
export type ComputerUseResponse = typeof ComputerUseResponse.Type;
