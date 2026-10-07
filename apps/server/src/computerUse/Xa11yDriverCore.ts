/**
 * The computer-use driver's worker logic: everything that runs inside the
 * forked driver process except the IPC loop. It holds the native xa11y
 * objects behind opaque handle strings it mints, so handles die with the
 * process and a restart can never retarget one.
 *
 * Handles carry a random per-process epoch (`w<epoch>.<n>`), so a handle
 * minted by a worker that has since crashed can never name something in its
 * replacement; it is refused as `stale` with a message saying the driver
 * restarted, not that the window closed. Element handles hold no native
 * object: every action resolves a fresh element from the window by the
 * child-index path recorded at observe and checks it is still the same
 * control, because xa11y elements are snapshots whose properties (and
 * bounds) never update.
 *
 * Focus: the accessibility actions behind refs (`press` = AXPress,
 * `setValue` = AXValue, `typeText` = accessible text insertion) act on the
 * element itself, so they run in the background: they never activate, raise
 * or focus anything and do not need the window in front. Only their
 * synthetic fallbacks (an InputSim click or typing after
 * `ActionNotSupported`) and every other input (`key`, `typeFocused`,
 * coordinate input, `scroll`) bring the exact target window to the front
 * and verify it is still there right before the native call. Input replies
 * report which happened as `tookFocus`.
 *
 * Messages it returns never carry element values, labels or titles: they are
 * fixed strings per failure class, because the server forwards them to the
 * agent and may log them.
 *
 * xa11y is injected (`Xa11yApi`) so the logic runs against xa11y's synthetic
 * test app in unit tests.
 */
import type { App, Element, InputSim, Rect, Screenshot } from "@crowecawcaw/xa11y";

import type { ComputerUseError, ComputerUseErrorCode } from "@t3tools/contracts";

import type {
  DriverElement,
  DriverElementIdentity,
  DriverErrorKind,
  DriverPoint,
  DriverStatus,
  DriverWindow,
  DriverDispatchPhase,
  DriverDispatchTarget,
} from "./ComputerDriver.ts";
import { downscaleRgba, encodePng, fitWithin } from "./ScreenshotImage.ts";

export interface Xa11yApi {
  readonly listApps: () => Promise<ReadonlyArray<App>>;
  /** Fresh snapshots of one app's top-level children, to re-read a window's bounds. */
  readonly appWindows: (pid: number) => Promise<ReadonlyArray<Element>>;
  /**
   * Whether the native object behind a retained snapshot still has a native
   * parent; checked before a fresh snapshot is matched to it by attributes.
   */
  readonly elementIsAlive: (element: Element) => Promise<boolean>;
  /** Pid of the foreground application, or null when the platform cannot say. */
  readonly foregroundPid: () => Promise<number | null>;
  readonly inputSim: () => InputSim;
  readonly screenshot: (element: Element) => Promise<Screenshot>;
  /** Executable path per pid, best effort; feeds `DriverWindow.appIdentifier`. */
  readonly executablePaths: (pids: ReadonlyArray<number>) => Promise<ReadonlyMap<number, string>>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Makes the app frontmost. AXRaise and AXFocused only order windows inside
   * an app, so on macOS this has to activate the app itself.
   */
  readonly activateApp: (pid: number) => Promise<void>;
  /** Logical rect of the primary display, or null when unknown. Re-read before each capture. */
  readonly primaryDisplay: () => Promise<Rect | null>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds; only for how long a display read is reused. */
  readonly now: () => number;
  /** The server's policy check (`ComputerDriverDispatchCheck`); a refusal comes back as the error. */
  readonly authorizeInput: (
    target: DriverDispatchTarget,
    phase: DriverDispatchPhase,
  ) => Promise<ComputerUseError | undefined>;
}

/** Env var carrying the per-spawn nonce the worker requires on every request. */
export const DRIVER_NONCE_ENV = "VIEWCODE_COMPUTER_DRIVER_NONCE";
/** Env var carrying the epoch the parent chose for this worker, so it can log it. */
export const DRIVER_EPOCH_ENV = "VIEWCODE_COMPUTER_DRIVER_EPOCH";

export interface DriverCoreOptions {
  readonly platform: NodeJS.Platform;
  /** Random per worker process; part of every handle. */
  readonly epoch: string;
}

export type DriverRequest =
  | { readonly op: "status" }
  | { readonly op: "listWindows" }
  /** Sent first to a replacement worker when the previous one died mid-drag. */
  | { readonly op: "releaseMouse" }
  | { readonly op: "observe"; readonly window: string; readonly maxElements: number }
  | {
      readonly op: "screenshot";
      readonly window: string;
      readonly outputPath: string;
      readonly maxSize: number;
    }
  | { readonly op: "elementAt"; readonly window: string; readonly point: DriverPoint }
  | {
      readonly op: "click";
      readonly window: string;
      readonly expectBounds: Rect;
      readonly point: DriverPoint;
      readonly button: "left" | "right" | "middle";
      readonly count: number;
    }
  | {
      readonly op: "drag";
      readonly window: string;
      readonly expectBounds: Rect;
      readonly from: DriverPoint;
      readonly to: DriverPoint;
    }
  | {
      readonly op: "move";
      readonly window: string;
      readonly expectBounds: Rect;
      readonly point: DriverPoint;
    }
  | {
      readonly op: "scrollAt";
      readonly window: string;
      readonly expectBounds: Rect;
      readonly point: DriverPoint;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly op: "typeFocused"; readonly window: string; readonly text: string }
  | { readonly op: "press"; readonly element: string; readonly expect: DriverElementIdentity }
  | {
      readonly op: "setValue";
      readonly element: string;
      readonly expect: DriverElementIdentity;
      readonly value: string;
    }
  | {
      readonly op: "typeText";
      readonly element: string;
      readonly expect: DriverElementIdentity;
      readonly text: string;
    }
  | { readonly op: "key"; readonly window: string; readonly keys: string }
  | {
      readonly op: "scroll";
      readonly element: string;
      readonly expect: DriverElementIdentity;
      readonly dx: number;
      readonly dy: number;
    };

export type DriverOp = DriverRequest["op"];

export interface DriverFailure {
  readonly kind: DriverErrorKind;
  readonly message: string;
  readonly dispatched: "no" | "yes" | "unknown";
  readonly code?: ComputerUseErrorCode;
  /** With `stale`: the handle was minted by an earlier worker (see `ComputerDriverError`). */
  readonly reason?: "restarted";
}

export type DriverResult =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly diagnostics?: { readonly windowEnumerationFailures: number };
    }
  | { readonly ok: false; readonly error: DriverFailure };

/** Every value the driver reports is clipped to this many characters. */
export const VALUE_MAX_CHARS = 200;
/** Nodes the observe walk may visit, whatever the returned cap. */
export const OBSERVE_MAX_VISITED = 4_000;
const OBSERVE_MAX_DEPTH = 64;
const OBSERVE_BATCH = 16;
/** Leaves room under the parent's observe timeout to answer `truncated`. */
const OBSERVE_TIME_BUDGET_MS = 8_000;
/** Bounds the handle tables across many windows; oldest handles go first. */
const MAX_ELEMENT_HANDLES = 20_000;
/** `elementAt` only names the target for an approval; it must stay quick. */
const ELEMENT_AT_TIME_BUDGET_MS = 3_000;
/** Coordinate input must refer to exactly the geometry in its screenshot. */
export const BOUNDS_TOLERANCE = 0;
/**
 * How long activation may take before input is refused. `open -a` on a busy
 * or managed Mac can take seconds; the worker timeouts in
 * `Xa11yComputerDriver.ts` leave room for it.
 */
export const ACTIVATION_TIMEOUT_MS = 3_000;
const ACTIVATION_POLL_MS = 50;
/**
 * How long a primary display read is reused. Reading it is a full-screen
 * capture; a window outside the cached rect re-reads at once, so staleness
 * can only wrongly accept a window for this long after displays change.
 */
const DISPLAY_CACHE_MS = 5_000;

const WINDOW_ROLES = new Set(["window", "dialog", "alert"]);

const nonEmpty = (value: string | null | undefined): string | undefined =>
  value !== null && value !== undefined && value.trim().length > 0 ? value : undefined;

/** The label the agent sees and the identity is checked against. */
export const elementLabel = (name: string | null, description: string | null): string =>
  nonEmpty(name) ?? nonEmpty(description) ?? "";

export const clipValue = (value: string): string =>
  value.length <= VALUE_MAX_CHARS ? value : `${value.slice(0, VALUE_MAX_CHARS - 1)}…`;

const SECURE_RAW = /secure|password/i;
const SECURE_LABEL = /pass(?:word|code|phrase)|\bpin\b/i;

/**
 * Secure text fields: macOS reports `AXSecureTextField`, AT-SPI a
 * "password text" role, UIA `IsPassword`. Platforms differ in where that
 * lands in `raw`, so any raw string or flag mentioning it counts, plus
 * editable fields labelled like a password. Over-matching only hides a value.
 */
export const isSecureElement = (element: {
  readonly raw: Record<string, unknown>;
  readonly editable: boolean;
  readonly label: string;
}): boolean => {
  for (const [key, value] of Object.entries(element.raw)) {
    if (typeof value === "string" && SECURE_RAW.test(value)) return true;
    if (value === true && SECURE_RAW.test(key)) return true;
  }
  return element.editable && SECURE_LABEL.test(element.label);
};

export const boundsMatch = (expected: Rect | null, actual: Rect | null): boolean =>
  expected !== null &&
  actual !== null &&
  Math.abs(expected.x - actual.x) <= BOUNDS_TOLERANCE &&
  Math.abs(expected.y - actual.y) <= BOUNDS_TOLERANCE &&
  Math.abs(expected.width - actual.width) <= BOUNDS_TOLERANCE &&
  Math.abs(expected.height - actual.height) <= BOUNDS_TOLERANCE;

const containsPoint = (rect: Rect, point: DriverPoint): boolean =>
  point.x >= rect.x &&
  point.y >= rect.y &&
  point.x <= rect.x + rect.width &&
  point.y <= rect.y + rect.height;

const rectInside = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

/**
 * The `.app` bundle that owns a macOS executable path, for `open -a`:
 * `/Applications/Foo.app/Contents/MacOS/Foo` → `/Applications/Foo.app`.
 * The last bundle wins, so a nested helper app activates itself.
 */
export const appBundlePath = (executablePath: string): string | undefined => {
  const marker = ".app/Contents/MacOS/";
  const index = executablePath.lastIndexOf(marker);
  return index === -1 ? undefined : executablePath.slice(0, index + ".app".length);
};

/** The labelled candidate with the smallest area whose bounds contain `point`. */
export const smallestContaining = <
  T extends { readonly bounds: Rect | null; readonly label: string },
>(
  candidates: Iterable<T>,
  point: DriverPoint,
): T | undefined => {
  let best: T | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const bounds = candidate.bounds;
    if (!bounds || candidate.label.length === 0 || !containsPoint(bounds, point)) continue;
    const area = bounds.width * bounds.height;
    if (area < bestArea) {
      best = candidate;
      bestArea = area;
    }
  }
  return best;
};

const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/**
 * `cmd+shift+z` → xa11y's `chord("z", ["Meta", "Shift"])`. `cmd` is the
 * Command key on macOS and Ctrl elsewhere, so `cmd+c` copies everywhere;
 * `meta`/`super` always mean the platform's Meta (Win, Super) key.
 */
export const translateKeyChord = (
  chord: string,
  platform: NodeJS.Platform,
): { readonly key: string; readonly held: ReadonlyArray<string> } | undefined => {
  const parts = chord.split("+");
  const last = parts.pop();
  if (last === undefined || last.length === 0) return undefined;
  const held: string[] = [];
  for (const modifier of parts) {
    const mapped =
      modifier === "cmd"
        ? platform === "darwin"
          ? "Meta"
          : "Ctrl"
        : modifier === "ctrl"
          ? "Ctrl"
          : modifier === "alt" || modifier === "option"
            ? "Alt"
            : modifier === "shift"
              ? "Shift"
              : modifier === "meta" || modifier === "super"
                ? "Meta"
                : undefined;
    if (mapped === undefined) return undefined;
    if (!held.includes(mapped)) held.push(mapped);
  }
  const key = /^[a-z0-9]$/.test(last)
    ? last
    : /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(last)
      ? last.toUpperCase()
      : NAMED_KEYS[last];
  return key === undefined ? undefined : { key, held };
};

/** A handle minted by an earlier worker: the window may well still be open. */
const RESTARTED_MESSAGES = {
  window: "The computer-use driver restarted; list windows again.",
  element: "The computer-use driver restarted; observe again.",
} as const;

/** The epoch part of a `<prefix><epoch>.<n>` handle, or undefined when it has none. */
const handleEpoch = (handle: string): string | undefined => {
  const dot = handle.lastIndexOf(".");
  return dot > 1 ? handle.slice(1, dot) : undefined;
};

const STATUS_MESSAGES = {
  unavailable: "The accessibility service is not available on this machine.",
  denied:
    "Accessibility permission is not granted to ViewCode. Grant it in System Settings > Privacy & Security > Accessibility.",
} as const;

const failure = (
  kind: DriverErrorKind,
  message: string,
  dispatched: DriverFailure["dispatched"] = "no",
): DriverResult => ({ ok: false, error: { kind, message, dispatched } });

/** Thrown inside an operation to answer with a specific failure. */
class Refusal {
  readonly result: DriverResult;
  constructor(result: DriverResult) {
    this.result = result;
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error === "string" ? error : "unknown";

/**
 * Maps an xa11y error to a driver failure. `afterDispatch` marks errors from
 * the call that sent input: an OS-level failure there may already have
 * landed, so it reports `unknown` unless the class says it never ran.
 */
export const classifyXa11yError = (
  error: unknown,
  context: { readonly afterDispatch: boolean; readonly screen?: boolean },
): DriverFailure => {
  const unknown = context.afterDispatch ? "unknown" : "no";
  switch (errorName(error)) {
    case "PermissionDeniedError":
      return context.screen
        ? {
            kind: "permission-screen",
            message:
              "Screen Recording permission is not granted to ViewCode. Grant it in System Settings > Privacy & Security > Screen Recording.",
            dispatched: "no",
          }
        : { kind: "permission-accessibility", message: STATUS_MESSAGES.denied, dispatched: "no" };
    case "SelectorNotMatchedError":
      return {
        kind: "stale",
        message: "The element or window no longer exists.",
        dispatched: "no",
      };
    case "ActionNotSupportedError":
      return {
        kind: "failed",
        message: "The element does not support this action.",
        dispatched: "no",
      };
    case "InvalidActionDataError":
      return { kind: "failed", message: "The element rejected the input.", dispatched: "no" };
    case "AccessibilityNotEnabledError":
      return {
        kind: "failed",
        message: "This app does not expose its accessibility tree.",
        dispatched: "no",
      };
    case "TimeoutError":
      return { kind: "timeout", message: "The OS did not respond in time.", dispatched: unknown };
    default:
      return {
        kind: "failed",
        message: "The OS refused or failed the action.",
        dispatched: unknown,
      };
  }
};

interface WindowEntry {
  readonly handle: string;
  element: Element;
  readonly pid: number;
  readonly app: string;
  readonly appIdentifier?: string;
  /** How listings recognise this window again; see `keyedWindows`. */
  key: string;
  /** Recognised by a native id; such a window is never matched any other way. */
  stable: boolean;
  /** False while another window shared its title (when it was last seen). */
  unique: boolean;
  role: string;
  title: string;
  bounds: Rect | null;
  elementHandles: Set<string>;
}

interface KeyedWindow {
  readonly key: string;
  readonly window: Element;
  readonly stable: boolean;
  /** False when another window shares the title and there is no native id. */
  readonly unique: boolean;
}

/**
 * Identity of an app's windows across snapshots. A native id counts only
 * when it is non-empty and unique among the app's windows (macOS reports
 * `AXIdentifier`, which apps reuse, e.g. "MainWindow"); otherwise role,
 * title and position among same-titled siblings.
 */
export const keyedWindows = (
  pid: number,
  children: ReadonlyArray<Element>,
): ReadonlyArray<KeyedWindow> => {
  const windows = children.filter((window) => WINDOW_ROLES.has(window.role));
  const idCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  for (const window of windows) {
    const id = window.stableId?.trim();
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    const titleKey = `${window.role}:${window.name ?? ""}`;
    titleCounts.set(titleKey, (titleCounts.get(titleKey) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  return windows.map((window) => {
    const id = window.stableId?.trim();
    const stable = id !== undefined && id.length > 0 && idCounts.get(id) === 1;
    const titleKey = `${window.role}:${window.name ?? ""}`;
    const ordinal = ordinals.get(titleKey) ?? 0;
    ordinals.set(titleKey, ordinal + 1);
    return {
      key: stable ? `s:${pid}:${id}` : `t:${pid}:${ordinal}:${titleKey}`,
      window,
      stable,
      unique: stable || titleCounts.get(titleKey) === 1,
    };
  });
};

/**
 * Finds `entry`'s window among fresh snapshots, failing closed: by key
 * (a window that has or had a same-titled sibling must also still be where
 * it was), else, only for a
 * window without a native id, the single window with the same role and
 * title at the same place. Anything else means the window is gone.
 */
export const findWindow = (
  entry: Pick<WindowEntry, "key" | "stable" | "unique" | "role" | "title" | "bounds">,
  keyed: ReadonlyArray<KeyedWindow>,
): KeyedWindow | undefined => {
  const byKey = keyed.filter((candidate) => candidate.key === entry.key);
  if (byKey.length === 1) {
    const candidate = byKey[0]!;
    // A window that had a same-titled sibling is only trusted where it was:
    // if the sibling closed, the survivor inherits the key.
    return (candidate.unique && entry.unique) || boundsMatch(entry.bounds, candidate.window.bounds)
      ? candidate
      : undefined;
  }
  if (entry.stable) return undefined;
  const sameSpot = keyed.filter(
    (candidate) =>
      !candidate.stable &&
      candidate.window.role === entry.role &&
      (candidate.window.name ?? "") === entry.title &&
      boundsMatch(entry.bounds, candidate.window.bounds),
  );
  return sameSpot.length === 1 ? sameSpot[0] : undefined;
};

const sameBounds = (left: Rect | null, right: Rect | null): boolean =>
  left === null || right === null ? left === right : boundsMatch(left, right);

/** What an input acts on, for the server's check. */
interface InputTarget {
  readonly element?: Element;
  readonly point?: DriverPoint;
  /** An accessibility action on the element itself: the window need not be in front. */
  readonly background?: boolean;
}

interface ElementEntry {
  readonly windowHandle: string;
  /** The observed snapshot, kept for its retained native object. */
  readonly element: Element;
  /** Child indexes from the window, to find the live element again. */
  readonly path: ReadonlyArray<number>;
  readonly role: string;
  /** Full label; the agent saw it clipped. */
  readonly label: string;
  /** Window bounds at observe: a moved window invalidates its refs. */
  readonly windowBounds: Rect | null;
  readonly bounds: Rect | null;
  readonly stableId: string | null;
}

export const makeDriverCore = (api: Xa11yApi, options: DriverCoreOptions) => {
  const { platform, epoch } = options;
  let nextHandle = 1;
  const windows = new Map<string, WindowEntry>();
  const elements = new Map<string, ElementEntry>();

  const mint = (prefix: string) => `${prefix}${epoch}.${nextHandle++}`;

  const dropElementHandles = (handles: Iterable<string>) => {
    for (const handle of handles) elements.delete(handle);
  };

  const stale = (message: string) => new Refusal(failure("stale", message));

  /** Refuses a handle minted by another worker with the restart message. */
  const requireOwnEpoch = (handle: string, kind: keyof typeof RESTARTED_MESSAGES) => {
    const owner = handleEpoch(handle);
    if (owner !== undefined && owner !== epoch) {
      throw new Refusal({
        ok: false,
        error: {
          kind: "stale",
          message: RESTARTED_MESSAGES[kind],
          dispatched: "no",
          reason: "restarted",
        },
      });
    }
  };

  const requireWindow = (handle: string): WindowEntry => {
    requireOwnEpoch(handle, "window");
    const entry = windows.get(handle);
    if (!entry) throw stale("Unknown window; list windows again.");
    return entry;
  };

  const adopt = (entry: WindowEntry, found: KeyedWindow) => {
    entry.element = found.window;
    entry.key = found.key;
    entry.stable = found.stable;
    entry.unique = found.unique;
    entry.role = found.window.role;
    entry.title = found.window.name ?? "";
    entry.bounds = found.window.bounds;
  };

  /** A fresh snapshot of the window (live bounds and state), or a `stale` refusal. */
  const refreshWindow = async (entry: WindowEntry): Promise<Element> => {
    if (!(await api.elementIsAlive(entry.element).catch(() => false))) {
      throw stale("The original window has closed.");
    }
    let children: ReadonlyArray<Element>;
    try {
      children = await api.appWindows(entry.pid);
    } catch (error) {
      if (errorName(error) !== "SelectorNotMatchedError") {
        throw new Refusal({
          ok: false,
          error: classifyXa11yError(error, { afterDispatch: false }),
        });
      }
      children = [];
    }
    const found = findWindow(entry, keyedWindows(entry.pid, children));
    if (!found) throw stale("The window has closed or can no longer be told apart.");
    adopt(entry, found);
    return found.window;
  };

  const isFront = async (entry: WindowEntry, live: Element) =>
    (live.active || live.focused) && (await api.foregroundPid().catch(() => null)) === entry.pid;

  /**
   * Activates the app, raises the window, and waits briefly until that exact
   * window is the active one; refuses otherwise, so synthesized input cannot
   * land in whatever else has focus (a sibling window, or ViewCode itself).
   */
  const activate = async (entry: WindowEntry): Promise<Element> => {
    let live = await refreshWindow(entry);
    if (await isFront(entry, live)) return live;
    await api.activateApp(entry.pid).catch(() => undefined);
    if (live.actions.includes("raise")) await live.performAction("raise").catch(() => undefined);
    await live.focus().catch(() => undefined);
    for (let waited = 0; ; waited += ACTIVATION_POLL_MS) {
      live = await refreshWindow(entry);
      if (await isFront(entry, live)) return live;
      if (waited >= ACTIVATION_TIMEOUT_MS) {
        throw new Refusal(failure("failed", "Could not bring the target window to the front."));
      }
      await api.sleep(ACTIVATION_POLL_MS);
    }
  };

  /** The last check before input: the target window is still the active one. */
  const verifyFront = async (entry: WindowEntry) => {
    const live = await refreshWindow(entry);
    if (!(await isFront(entry, live))) {
      throw new Refusal(failure("failed", "The target window lost focus before the input."));
    }
  };

  /**
   * The live element behind a handle: walks the recorded path from a fresh
   * window and refuses unless role, full label, bounds and native id still
   * match what was observed (and what the service expects), the window has
   * not moved, and the observed native object still exists.
   *
   * Limit: xa11y exposes no native identity (no AXUIElement handle or
   * CFEqual), so the fresh path element cannot be proved to be the observed
   * object. A re-rendered replacement is refused because the observed object
   * lost its parent; a twin identical in every compared field, at the same
   * path while the observed object is still alive elsewhere (or in an app
   * that keeps answering AXParent for a destroyed object), is acted on.
   */
  const resolveElement = async (handle: string, expect: DriverElementIdentity) => {
    requireOwnEpoch(handle, "element");
    const entry = elements.get(handle);
    if (!entry) throw stale("Unknown element; observe again.");
    if (expect.role !== entry.role || expect.label !== clipValue(entry.label)) {
      throw stale("The element changed since it was observed.");
    }
    if (!(await api.elementIsAlive(entry.element).catch(() => false))) {
      throw stale("The observed element is gone; observe again.");
    }
    const windowEntry = requireWindow(entry.windowHandle);
    let current = await refreshWindow(windowEntry);
    if (!sameBounds(entry.windowBounds, current.bounds)) {
      throw stale("The window moved or resized since it was observed.");
    }
    for (const index of entry.path) {
      let children: ReadonlyArray<Element>;
      try {
        children = await current.children();
      } catch (error) {
        throw new Refusal({
          ok: false,
          error: classifyXa11yError(error, { afterDispatch: false }),
        });
      }
      const next = children[index];
      if (!next) throw stale("The element changed since it was observed.");
      current = next;
    }
    if (
      current.role !== entry.role ||
      elementLabel(current.name, current.description) !== entry.label ||
      !sameBounds(entry.bounds, current.bounds) ||
      current.stableId !== entry.stableId
    ) {
      throw stale("The element changed since it was observed.");
    }
    return { element: current, window: windowEntry };
  };

  /** Constructing input fails before anything is sent (e.g. Wayland, no uinput). */
  const requireInput = (): InputSim => {
    try {
      return api.inputSim();
    } catch {
      throw new Refusal(failure("failed", "Input simulation is not available on this machine."));
    }
  };

  /** Steps that only prepare input; their failure means nothing was sent. */
  const beforeDispatch = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      throw new Refusal({ ok: false, error: classifyXa11yError(error, { afterDispatch: false }) });
    }
  };

  /**
   * Asks the server to re-read policy for this exact native target: in the
   * `prepare` phase before activating, raising or focusing anything, and in
   * the `dispatch` phase immediately before native input (including a
   * fallback that prepared its target again), where the window must also
   * still be unmoved and, unless the input is a `background` accessibility
   * action, in front. Nothing has been sent when it refuses.
   */
  const authorize = async (
    entry: WindowEntry,
    phase: DriverDispatchPhase,
    target: InputTarget = {},
  ) => {
    try {
      await authorizeChecked(entry, phase, target);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal({ ok: false, error: classifyXa11yError(error, { afterDispatch: false }) });
    }
  };

  const authorizeChecked = async (
    entry: WindowEntry,
    phase: DriverDispatchPhase,
    { element, point, background = false }: InputTarget,
  ) => {
    const expectedBounds = entry.bounds;
    const live = await refreshWindow(entry);
    if (!sameBounds(expectedBounds, live.bounds)) throw stale("The window moved before dispatch.");
    const path = (await api.executablePaths([entry.pid])).get(entry.pid) ?? entry.appIdentifier;
    const identity = element
      ? { role: element.role, label: elementLabel(element.name, element.description) }
      : point && phase === "dispatch"
        ? await elementAtHandle(entry, point, false)
        : undefined;
    const refusal = await api.authorizeInput(
      {
        window: {
          handle: entry.handle,
          app: entry.app,
          pid: entry.pid,
          title: live.name ?? "",
          focused: live.active,
          ...(path ? { appIdentifier: path } : {}),
        },
        ...(identity ? { element: identity } : {}),
      },
      phase,
    );
    if (refusal)
      throw new Refusal({
        ok: false,
        error: { kind: "policy", code: refusal.code, message: refusal.message, dispatched: "no" },
      });
    if (phase === "prepare") return;
    const current = await refreshWindow(entry);
    if (!sameBounds(live.bounds, current.bounds)) throw stale("The window moved before dispatch.");
    if (!background && !(await isFront(entry, current))) {
      throw new Refusal(failure("failed", "The target window lost focus before the input."));
    }
  };

  /**
   * Authorizes and runs the input. The result says whether the app was
   * brought to the front: always for foreground input, and for a
   * `background` action only when `run` says its fallback activated it.
   */
  const dispatch = async (
    run: () => Promise<boolean | void>,
    entry: WindowEntry,
    target: InputTarget = {},
  ): Promise<DriverResult> => {
    await authorize(entry, "dispatch", target);
    try {
      const fellBack = await run();
      const tookFocus = target.background === true ? fellBack === true : true;
      return { ok: true, result: { tookFocus } };
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      return { ok: false, error: classifyXa11yError(error, { afterDispatch: true }) };
    }
  };

  const status = async (): Promise<DriverStatus> => {
    try {
      await api.listApps();
      return { available: true, accessibility: "granted" };
    } catch (error) {
      if (errorName(error) === "PermissionDeniedError") {
        return { available: true, accessibility: "denied", reason: STATUS_MESSAGES.denied };
      }
      return { available: false, accessibility: "unknown", reason: STATUS_MESSAGES.unavailable };
    }
  };

  const listWindows = async () => {
    const apps = await api.listApps().catch((error: unknown) => {
      throw new Refusal(
        errorName(error) === "PermissionDeniedError"
          ? { ok: false, error: classifyXa11yError(error, { afterDispatch: false }) }
          : failure("unavailable", STATUS_MESSAGES.unavailable),
      );
    });
    let windowEnumerationFailures = 0;
    const perApp = await Promise.all(
      apps.map(async (app) => ({
        app,
        children: await app.children().catch(() => {
          windowEnumerationFailures += 1;
          return [] as Element[];
        }),
      })),
    );
    const pids = [...new Set(perApp.flatMap(({ app }) => (app.pid === null ? [] : [app.pid])))];
    const paths = await api.executablePaths(pids).catch(() => new Map<number, string>());
    const kept = new Set<string>();
    const listed: DriverWindow[] = [];
    for (const { app, children } of perApp) {
      const pid = app.pid ?? 0;
      const keyed = keyedWindows(pid, children);
      // Known windows first: each keeps its handle (so the server keeps its
      // id) only if it is found unambiguously; a window is claimed once.
      const claimed = new Map<Element, string>();
      for (const [handle, entry] of windows) {
        if (entry.pid !== pid || kept.has(handle)) continue;
        if (!(await api.elementIsAlive(entry.element).catch(() => false))) continue;
        const found = findWindow(entry, keyed);
        if (!found || claimed.has(found.window)) continue;
        adopt(entry, found);
        claimed.set(found.window, handle);
        kept.add(handle);
      }
      for (const found of keyed) {
        let handle = claimed.get(found.window);
        if (handle === undefined) {
          handle = mint("w");
          const window = found.window;
          windows.set(handle, {
            handle,
            element: window,
            pid,
            app: app.name,
            ...(paths.get(pid) ? { appIdentifier: paths.get(pid)! } : {}),
            key: found.key,
            stable: found.stable,
            unique: found.unique,
            role: window.role,
            title: window.name ?? "",
            bounds: window.bounds,
            elementHandles: new Set(),
          });
          kept.add(handle);
        }
        const window = found.window;
        const bounds = window.bounds;
        const appIdentifier = paths.get(pid);
        listed.push({
          handle,
          app: app.name,
          pid,
          title: window.name ?? "",
          focused: app.isForeground && (window.active || window.focused),
          ...(bounds ? { bounds: { ...bounds } } : {}),
          ...(appIdentifier ? { appIdentifier } : {}),
        });
      }
    }
    // Windows not found again are gone; forget them and their refs.
    for (const [handle, entry] of windows) {
      if (kept.has(handle)) continue;
      dropElementHandles(entry.elementHandles);
      windows.delete(handle);
    }
    return { listed, windowEnumerationFailures };
  };

  /**
   * Breadth-first over a window's subtree, in batches of concurrent
   * `children()` calls, until `onChild` says stop or a cap is hit. Returns
   * whether the walk was cut short.
   */
  const walkBreadthFirst = async (
    root: Element,
    budgetMs: number,
    onChild: (child: Element, path: ReadonlyArray<number>) => "continue" | "stop",
  ): Promise<boolean> => {
    const startedAt = performance.now();
    type Node = { readonly element: Element; readonly path: ReadonlyArray<number> };
    let frontier: Node[] = [{ element: root, path: [] }];
    let visited = 0;
    while (frontier.length > 0) {
      const next: Node[] = [];
      for (let start = 0; start < frontier.length; start += OBSERVE_BATCH) {
        if (performance.now() - startedAt > budgetMs) return true;
        const batch = frontier.slice(start, start + OBSERVE_BATCH);
        const children = await Promise.all(
          batch.map((node) =>
            node.path.length >= OBSERVE_MAX_DEPTH
              ? Promise.resolve([] as Element[])
              : node.element.children().catch(() => [] as Element[]),
          ),
        );
        for (const [index, node] of batch.entries()) {
          for (const [childIndex, child] of (children[index] ?? []).entries()) {
            if (visited >= OBSERVE_MAX_VISITED) return true;
            visited += 1;
            const path = [...node.path, childIndex];
            if (onChild(child, path) === "stop") return true;
            next.push({ element: child, path });
          }
        }
      }
      frontier = next;
    }
    return false;
  };

  const observe = async (
    windowHandle: string,
    maxElements: number,
  ): Promise<{ readonly elements: ReadonlyArray<DriverElement>; readonly truncated: boolean }> => {
    const window = requireWindow(windowHandle);
    const root = await refreshWindow(window);
    const cap = Math.max(0, Math.min(maxElements, OBSERVE_MAX_VISITED));
    const kept: Array<{ readonly element: Element; readonly path: ReadonlyArray<number> }> = [];
    // Breadth-first so a cap keeps the shallow, structural controls; the
    // result is re-sorted into reading order below.
    const truncated = await walkBreadthFirst(root, OBSERVE_TIME_BUDGET_MS, (child, path) => {
      const label = elementLabel(child.name, child.description);
      const actionable = child.actions.length > 0 || child.editable;
      if (label.length === 0 && !actionable) return "continue";
      if (kept.length >= cap) return "stop";
      kept.push({ element: child, path });
      return "continue";
    });
    kept.sort((left, right) => comparePaths(left.path, right.path));

    // A new observation of a window replaces its previous handles.
    dropElementHandles(window.elementHandles);
    window.elementHandles = new Set();
    const observed: DriverElement[] = [];
    for (const { element, path } of kept) {
      const handle = mint("e");
      const label = elementLabel(element.name, element.description);
      elements.set(handle, {
        windowHandle,
        element,
        path,
        role: element.role,
        label,
        windowBounds: root.bounds,
        bounds: element.bounds,
        stableId: element.stableId,
      });
      window.elementHandles.add(handle);
      const value = nonEmpty(element.value);
      const secure = isSecureElement({ raw: element.raw, editable: element.editable, label });
      observed.push({
        handle,
        role: element.role,
        label: clipValue(label),
        ...(value !== undefined && !secure ? { value: clipValue(value) } : {}),
        enabled: element.enabled,
        focused: element.focused,
      });
    }
    while (elements.size > MAX_ELEMENT_HANDLES) {
      const oldest = elements.keys().next().value;
      if (oldest === undefined) break;
      elements.delete(oldest);
    }
    return { elements: observed, truncated };
  };

  let display: { readonly rect: Rect; readonly at: number } | undefined;

  /** A fresh primary display rect; an unknown one refuses the capture. */
  const readDisplay = async (): Promise<Rect> => {
    display = undefined;
    let rect: Rect | null;
    try {
      rect = await api.primaryDisplay();
    } catch (error) {
      throw new Refusal({
        ok: false,
        error: classifyXa11yError(error, { afterDispatch: false, screen: true }),
      });
    }
    if (!rect) {
      throw new Refusal(
        failure("failed", "Could not resolve the main display for this screenshot."),
      );
    }
    display = { rect, at: api.now() };
    return rect;
  };

  /**
   * xa11y's macOS capture reads the primary display only, so a window
   * elsewhere would come back as the wrong pixels. The main display and its
   * scale can change, so a read is reused for `DISPLAY_CACHE_MS` at most and
   * a window outside it re-reads before refusing.
   */
  const onPrimaryDisplay = async (bounds: Rect): Promise<boolean> => {
    if (platform !== "darwin") return true;
    const cached = display;
    if (cached && api.now() - cached.at < DISPLAY_CACHE_MS && rectInside(cached.rect, bounds)) {
      return true;
    }
    return rectInside(await readDisplay(), bounds);
  };

  /**
   * Captures the window at its live bounds and downscales to `maxSize`
   * (box filter, longest edge). `bounds` is the logical screen rect the
   * image covers, the space InputSim uses, so the service can map image
   * pixels to screen points whatever the display scale.
   */
  const screenshot = async (windowHandle: string, outputPath: string, maxSize: number) => {
    const window = await refreshWindow(requireWindow(windowHandle));
    const bounds = window.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      throw new Refusal(failure("failed", "The window is not on screen."));
    }
    if (!(await onPrimaryDisplay(bounds))) {
      throw new Refusal(
        failure("failed", "The window is not fully on the main display; move it there."),
      );
    }
    let shot: Screenshot;
    try {
      shot = await api.screenshot(window);
    } catch (error) {
      throw new Refusal({
        ok: false,
        error: classifyXa11yError(error, { afterDispatch: false, screen: true }),
      });
    }
    const size = fitWithin(shot.width, shot.height, maxSize);
    const png =
      size.width === shot.width && size.height === shot.height
        ? shot.toPng()
        : encodePng(
            downscaleRgba(shot.pixels, shot.width, shot.height, size.width, size.height),
            size.width,
            size.height,
          );
    await api.writeFile(outputPath, png);
    return { ...size, bounds: { ...bounds } };
  };

  /** Best effort: names what a coordinate action would hit, for the approval. */
  const elementAtHandle = async (
    entry: WindowEntry,
    point: DriverPoint,
    clip = true,
  ): Promise<DriverElementIdentity | null> => {
    const root = await refreshWindow(entry);
    const candidates: Array<{
      readonly bounds: Rect | null;
      readonly label: string;
      readonly role: string;
    }> = [];
    await walkBreadthFirst(root, ELEMENT_AT_TIME_BUDGET_MS, (child) => {
      const bounds = child.bounds;
      // Children are laid out inside their parents, so a miss prunes nothing
      // reliably (overlays); keep walking and pick the smallest hit.
      if (bounds && containsPoint(bounds, point)) {
        candidates.push({
          bounds,
          role: child.role,
          label: elementLabel(child.name, child.description),
        });
      }
      return "continue";
    });
    const hit = smallestContaining(candidates, point);
    return hit ? { role: hit.role, label: clip ? clipValue(hit.label) : hit.label } : null;
  };

  const elementAt = (windowHandle: string, point: DriverPoint) =>
    elementAtHandle(requireWindow(windowHandle), point);

  /**
   * Coordinate input: input ready, the window active and still exactly where
   * the screenshot saw it; otherwise refused before anything is sent.
   */
  const prepareCoordinate = async (
    windowHandle: string,
    expectBounds: Rect,
    points: ReadonlyArray<DriverPoint>,
  ): Promise<InputSim> => {
    const entry = requireWindow(windowHandle);
    const input = requireInput();
    await authorize(entry, "prepare");
    const live = await activate(entry);
    const area = live.bounds;
    if (!area || !boundsMatch(expectBounds, area)) {
      throw stale("The window moved or resized since the screenshot.");
    }
    if (!points.every((point) => containsPoint(area, point))) {
      throw new Refusal(failure("failed", "The point is outside the window."));
    }
    return input;
  };

  const typeInputText = async (input: InputSim, text: string, window: WindowEntry) => {
    if (platform !== "darwin") {
      await input.typeText(text);
      return;
    }
    // xa11y batches up to 20 Unicode characters into one macOS key pair.
    // Some app fields can consume only its first character. Send complete code
    // points individually without clipboard mutation or replay. The dispatch
    // check covers the first event; stop if focus changes before later events.
    let sent = false;
    try {
      for (const character of text) {
        if (sent) await verifyFront(window);
        await input.typeText(character);
        sent = true;
      }
    } catch (error) {
      if (!sent) throw error;
      const failure =
        error instanceof Refusal && !error.result.ok
          ? error.result.error
          : classifyXa11yError(error, { afterDispatch: true });
      // Earlier characters were already sent, even if this event was refused.
      throw new Refusal({ ok: false, error: { ...failure, dispatched: "unknown" } });
    }
  };

  const handle = async (request: DriverRequest): Promise<DriverResult> => {
    try {
      switch (request.op) {
        case "status":
          return { ok: true, result: await status() };
        case "listWindows": {
          const { listed, windowEnumerationFailures } = await listWindows();
          return {
            ok: true,
            result: listed,
            ...(windowEnumerationFailures > 0
              ? { diagnostics: { windowEnumerationFailures } }
              : {}),
          };
        }
        case "releaseMouse": {
          await Promise.resolve()
            .then(() => api.inputSim().mouseUp("left"))
            .catch(() => undefined);
          return { ok: true, result: null };
        }
        case "observe":
          return { ok: true, result: await observe(request.window, request.maxElements) };
        case "screenshot":
          return {
            ok: true,
            result: await screenshot(request.window, request.outputPath, request.maxSize),
          };
        case "elementAt":
          return { ok: true, result: await elementAt(request.window, request.point) };
        case "click": {
          const { point, button, count } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [point]);
          return await dispatch(
            () => input.click([point.x, point.y], { button, count }),
            requireWindow(request.window),
            { point },
          );
        }
        case "drag": {
          const { from, to } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [from, to]);
          return await dispatch(
            () => input.drag([from.x, from.y], [to.x, to.y]),
            requireWindow(request.window),
            { point: from },
          );
        }
        case "move": {
          const { point } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [point]);
          return await dispatch(
            () => input.moveTo([point.x, point.y]),
            requireWindow(request.window),
            { point },
          );
        }
        case "scrollAt": {
          const { point } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [point]);
          return await dispatch(
            () => input.scroll([point.x, point.y], request.dx, request.dy),
            requireWindow(request.window),
            { point },
          );
        }
        case "typeFocused": {
          const window = requireWindow(request.window);
          const input = requireInput();
          await authorize(window, "prepare");
          await activate(window);
          return await dispatch(() => typeInputText(input, request.text, window), window);
        }
        case "key": {
          const window = requireWindow(request.window);
          const chord = translateKeyChord(request.keys, platform);
          if (!chord) return failure("failed", "Unsupported key chord.");
          const input = requireInput();
          await authorize(window, "prepare");
          await activate(window);
          return await dispatch(
            () =>
              chord.held.length === 0
                ? input.press(chord.key)
                : input.chord(chord.key, [...chord.held]),
            window,
          );
        }
        case "press": {
          const first = await resolveElement(request.element, request.expect);
          await authorize(first.window, "prepare", { element: first.element });
          const target = await resolveElement(request.element, request.expect);
          return await dispatch(
            async () => {
              try {
                await target.element.press();
                return false;
              } catch (error) {
                if (errorName(error) !== "ActionNotSupportedError") throw error;
              }
              // No accessible press: bring the window to the front and click
              // the live element's centre. The preparation can outlast the
              // policy, so the click is authorized again, with its window
              // verifiably the active one.
              const input = requireInput();
              await authorize(target.window, "prepare", { element: target.element });
              await activate(target.window);
              const fresh = await resolveElement(request.element, request.expect);
              if (!fresh.element.bounds) {
                throw new Refusal(failure("failed", "The element cannot be pressed."));
              }
              await authorize(fresh.window, "dispatch", { element: fresh.element });
              await input.click(fresh.element);
              return true;
            },
            target.window,
            { element: target.element, background: true },
          );
        }
        case "setValue": {
          const target = await resolveElement(request.element, request.expect);
          await authorize(target.window, "prepare", { element: target.element });
          const fresh = await resolveElement(request.element, request.expect);
          return await dispatch(() => fresh.element.setValue(request.value), fresh.window, {
            element: fresh.element,
            background: true,
          });
        }
        case "typeText": {
          const first = await resolveElement(request.element, request.expect);
          await authorize(first.window, "prepare", { element: first.element });
          const target = await resolveElement(request.element, request.expect);
          return await dispatch(
            async () => {
              try {
                await target.element.typeText(request.text);
                return false;
              } catch (error) {
                if (errorName(error) !== "ActionNotSupportedError") throw error;
              }
              // No accessible text insertion: bring the window to the front,
              // focus the element and type, authorized again after that
              // preparation.
              const input = requireInput();
              await authorize(target.window, "prepare", { element: target.element });
              await activate(target.window);
              const fresh = await resolveElement(request.element, request.expect);
              await beforeDispatch(() => fresh.element.focus());
              await authorize(fresh.window, "dispatch", { element: fresh.element });
              await typeInputText(input, request.text, fresh.window);
              return true;
            },
            target.window,
            { element: target.element, background: true },
          );
        }
        case "scroll": {
          const input = requireInput();
          const first = await resolveElement(request.element, request.expect);
          await authorize(first.window, "prepare", { element: first.element });
          await activate(first.window);
          const target = await resolveElement(request.element, request.expect);
          await verifyFront(target.window);
          return await dispatch(
            () => input.scroll(target.element, request.dx, request.dy),
            target.window,
            { element: target.element },
          );
        }
      }
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      return { ok: false, error: classifyXa11yError(error, { afterDispatch: false }) };
    }
  };

  return { handle };
};

const comparePaths = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};
