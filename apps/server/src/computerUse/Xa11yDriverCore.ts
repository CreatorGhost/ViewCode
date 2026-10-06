/**
 * The computer-use driver's worker logic: everything that runs inside the
 * forked driver process except the IPC loop. It holds the native xa11y
 * objects behind opaque handle strings it mints, so handles die with the
 * process and a restart can never retarget one.
 *
 * Messages it returns never carry element values, labels or titles: they are
 * fixed strings per failure class, because the server forwards them to the
 * agent and may log them.
 *
 * xa11y is injected (`Xa11yApi`) so the logic runs against xa11y's synthetic
 * test app in unit tests.
 */
import type { App, Element, InputSim, Rect, Screenshot } from "@crowecawcaw/xa11y";

import type {
  DriverElement,
  DriverElementIdentity,
  DriverErrorKind,
  DriverPoint,
  DriverStatus,
  DriverWindow,
} from "./ComputerDriver.ts";
import { downscaleRgba, encodePng, fitWithin } from "./ScreenshotImage.ts";

export interface Xa11yApi {
  readonly listApps: () => Promise<ReadonlyArray<App>>;
  /** Fresh snapshots of one app's top-level children, to re-read a window's bounds. */
  readonly appWindows: (pid: number) => Promise<ReadonlyArray<Element>>;
  /** Pid of the foreground application, or null when the platform cannot say. */
  readonly foregroundPid: () => Promise<number | null>;
  readonly inputSim: () => InputSim;
  readonly screenshot: (element: Element) => Promise<Screenshot>;
  /** Executable path per pid, best effort; feeds `DriverWindow.appIdentifier`. */
  readonly executablePaths: (pids: ReadonlyArray<number>) => Promise<ReadonlyMap<number, string>>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

export type DriverRequest =
  | { readonly op: "status" }
  | { readonly op: "listWindows" }
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
}

export type DriverResult =
  | { readonly ok: true; readonly result: unknown }
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
/** Points a window may drift between screenshot and action and still be the same layout. */
export const BOUNDS_TOLERANCE = 2;

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

export const boundsMatch = (expected: Rect, actual: Rect | null): boolean =>
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
  element: Element;
  readonly pid: number;
  /** How listings recognise this window again; see `windowKey`. */
  key: string;
  elementHandles: Set<string>;
}

/**
 * Identity of a window across snapshots: the platform id when there is
 * one, else role, title and position among same-titled siblings.
 */
const windowKey = (pid: number, window: Element, ordinal: number): string =>
  window.stableId !== null
    ? `s:${pid}:${window.stableId}`
    : `t:${pid}:${window.role}:${ordinal}:${window.name ?? ""}`;

/** Keys for an app's top-level windows, in order. */
const keyedWindows = (pid: number, children: ReadonlyArray<Element>) => {
  const ordinals = new Map<string, number>();
  const keyed: Array<{ readonly key: string; readonly window: Element }> = [];
  for (const window of children) {
    if (!WINDOW_ROLES.has(window.role)) continue;
    const title = window.name ?? "";
    const ordinal = ordinals.get(title) ?? 0;
    ordinals.set(title, ordinal + 1);
    keyed.push({ key: windowKey(pid, window, ordinal), window });
  }
  return keyed;
};

/**
 * Finds `entry`'s window among fresh snapshots: by key, else the one window
 * of the same role still where it was (a browser retitles on navigation).
 */
const findWindow = (
  entry: WindowEntry,
  keyed: ReadonlyArray<{ readonly key: string; readonly window: Element }>,
) => {
  const byKey = keyed.find((candidate) => candidate.key === entry.key);
  if (byKey) return byKey;
  const sameSpot = keyed.filter(
    (candidate) =>
      candidate.window.role === entry.element.role &&
      entry.element.bounds !== null &&
      boundsMatch(entry.element.bounds, candidate.window.bounds),
  );
  return sameSpot.length === 1 ? sameSpot[0] : undefined;
};

interface ElementEntry {
  readonly element: Element;
  readonly windowHandle: string;
  readonly pid: number;
}

export const makeDriverCore = (api: Xa11yApi, platform: NodeJS.Platform) => {
  let nextHandle = 1;
  const windowsByKey = new Map<string, string>();
  const windows = new Map<string, WindowEntry>();
  const elements = new Map<string, ElementEntry>();

  const mint = (prefix: string) => `${prefix}${nextHandle++}`;

  const dropElementHandles = (handles: Iterable<string>) => {
    for (const handle of handles) elements.delete(handle);
  };

  const requireWindow = (handle: string): WindowEntry => {
    const entry = windows.get(handle);
    if (!entry) throw new Refusal(failure("stale", "Unknown window; list windows again."));
    return entry;
  };

  /** Re-reads the live element and refuses unless it is still what the agent saw. */
  const requireIdentity = async (
    handle: string,
    expect: DriverElementIdentity,
  ): Promise<ElementEntry> => {
    const entry = elements.get(handle);
    if (!entry) throw new Refusal(failure("stale", "Unknown element; observe again."));
    let live: { readonly role: string; readonly name?: string };
    try {
      live = await entry.element.tree(0);
    } catch (error) {
      throw new Refusal({ ok: false, error: classifyXa11yError(error, { afterDispatch: false }) });
    }
    // `tree` carries no description, so a label that came from the
    // description is compared against the snapshot's.
    const label = elementLabel(live.name ?? null, entry.element.description);
    if (live.role !== expect.role || label !== expect.label) {
      throw new Refusal(failure("stale", "The element changed since it was observed."));
    }
    return entry;
  };

  /**
   * Raises the window and refuses unless its app is then in front, so
   * synthesized keys or clicks cannot land in whatever else has focus.
   */
  const bringToFront = async (window: Element, pid: number) => {
    if (window.actions.includes("raise")) {
      await window.performAction("raise").catch(() => undefined);
    }
    await window.focus().catch(() => undefined);
    const foreground = await api.foregroundPid().catch(() => null);
    if (foreground !== pid) {
      throw new Refusal(failure("failed", "Could not bring the target window to the front."));
    }
  };

  const windowOf = (entry: ElementEntry): WindowEntry => requireWindow(entry.windowHandle);

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

  const dispatch = async (run: () => Promise<void>): Promise<DriverResult> => {
    try {
      await run();
      return { ok: true, result: null };
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

  const listWindows = async (): Promise<ReadonlyArray<DriverWindow>> => {
    const apps = await api.listApps().catch((error: unknown) => {
      throw new Refusal(
        errorName(error) === "PermissionDeniedError"
          ? { ok: false, error: classifyXa11yError(error, { afterDispatch: false }) }
          : failure("unavailable", STATUS_MESSAGES.unavailable),
      );
    });
    const perApp = await Promise.all(
      apps.map(async (app) => ({
        app,
        children: await app.children().catch(() => [] as Element[]),
      })),
    );
    const pids = [...new Set(perApp.flatMap(({ app }) => (app.pid === null ? [] : [app.pid])))];
    const paths = await api.executablePaths(pids).catch(() => new Map<number, string>());
    const seen = new Set<string>();
    const listed: DriverWindow[] = [];
    for (const { app, children } of perApp) {
      const pid = app.pid ?? 0;
      const keyed = keyedWindows(pid, children);
      for (const { key, window } of keyed) {
        // The same window keeps its handle across listings, so the server
        // keeps its id, even when its title changed in place.
        let handle = windowsByKey.get(key);
        if (handle === undefined || !windows.has(handle)) {
          const moved = [...windows].find(
            ([candidate, entry]) =>
              entry.pid === pid &&
              !seen.has(candidate) &&
              findWindow(entry, keyed)?.window === window,
          );
          handle = moved?.[0] ?? mint("w");
        }
        seen.add(handle);
        const existing = windows.get(handle);
        if (existing) {
          windowsByKey.delete(existing.key);
          existing.element = window;
          existing.key = key;
        } else {
          windows.set(handle, { element: window, pid, key, elementHandles: new Set() });
        }
        windowsByKey.set(key, handle);
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
    // Windows missing from a full listing are gone; forget them.
    for (const [handle, entry] of windows) {
      if (seen.has(handle)) continue;
      windowsByKey.delete(entry.key);
      dropElementHandles(entry.elementHandles);
      windows.delete(handle);
    }
    return listed;
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

  /** A fresh snapshot of the window (live bounds), or a `stale` refusal. */
  const refreshWindow = async (entry: WindowEntry): Promise<Element> => {
    let children: ReadonlyArray<Element>;
    try {
      children = await api.appWindows(entry.pid);
    } catch (error) {
      if (errorName(error) === "SelectorNotMatchedError") children = [];
      else
        throw new Refusal({
          ok: false,
          error: classifyXa11yError(error, { afterDispatch: false }),
        });
    }
    const found = findWindow(entry, keyedWindows(entry.pid, children));
    if (!found) throw new Refusal(failure("stale", "The window has closed."));
    entry.element = found.window;
    return found.window;
  };

  const observe = async (
    windowHandle: string,
    maxElements: number,
  ): Promise<{ readonly elements: ReadonlyArray<DriverElement>; readonly truncated: boolean }> => {
    const window = requireWindow(windowHandle);
    const cap = Math.max(0, Math.min(maxElements, OBSERVE_MAX_VISITED));
    const kept: Array<{ readonly element: Element; readonly path: ReadonlyArray<number> }> = [];
    // Breadth-first so a cap keeps the shallow, structural controls; the
    // result is re-sorted into reading order below.
    const truncated = await walkBreadthFirst(
      window.element,
      OBSERVE_TIME_BUDGET_MS,
      (child, path) => {
        const label = elementLabel(child.name, child.description);
        const actionable = child.actions.length > 0 || child.editable;
        if (label.length === 0 && !actionable) return "continue";
        if (kept.length >= cap) return "stop";
        kept.push({ element: child, path });
        return "continue";
      },
    );
    kept.sort((left, right) => comparePaths(left.path, right.path));

    // A new observation of a window replaces its previous handles.
    dropElementHandles(window.elementHandles);
    window.elementHandles = new Set();
    const observed: DriverElement[] = [];
    for (const { element } of kept) {
      const handle = mint("e");
      elements.set(handle, { element, windowHandle, pid: window.pid });
      window.elementHandles.add(handle);
      const label = elementLabel(element.name, element.description);
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
  const elementAt = async (
    windowHandle: string,
    point: DriverPoint,
  ): Promise<DriverElementIdentity | null> => {
    const window = requireWindow(windowHandle);
    const candidates: Array<{
      readonly bounds: Rect | null;
      readonly label: string;
      readonly role: string;
    }> = [];
    await walkBreadthFirst(window.element, ELEMENT_AT_TIME_BUDGET_MS, (child) => {
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
    return hit ? { role: hit.role, label: clipValue(hit.label) } : null;
  };

  /**
   * Coordinate input: input ready, window in front, and still exactly where
   * the screenshot saw it; otherwise `stale` before anything is sent.
   */
  const prepareCoordinate = async (
    windowHandle: string,
    expectBounds: Rect,
    points: ReadonlyArray<DriverPoint>,
  ): Promise<InputSim> => {
    const entry = requireWindow(windowHandle);
    const input = requireInput();
    await bringToFront(entry.element, entry.pid);
    const live = await refreshWindow(entry);
    if (!boundsMatch(expectBounds, live.bounds)) {
      throw new Refusal(failure("stale", "The window moved or resized since the screenshot."));
    }
    const area = live.bounds!;
    const slack = {
      ...area,
      x: area.x - 1,
      y: area.y - 1,
      width: area.width + 2,
      height: area.height + 2,
    };
    if (!points.every((point) => containsPoint(slack, point))) {
      throw new Refusal(failure("failed", "The point is outside the window."));
    }
    return input;
  };

  const handle = async (request: DriverRequest): Promise<DriverResult> => {
    try {
      switch (request.op) {
        case "status":
          return { ok: true, result: await status() };
        case "listWindows":
          return { ok: true, result: await listWindows() };
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
          return await dispatch(() => input.click([point.x, point.y], { button, count }));
        }
        case "drag": {
          const { from, to } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [from, to]);
          return await dispatch(() => input.drag([from.x, from.y], [to.x, to.y]));
        }
        case "move": {
          const { point } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [point]);
          return await dispatch(() => input.moveTo([point.x, point.y]));
        }
        case "scrollAt": {
          const { point } = request;
          const input = await prepareCoordinate(request.window, request.expectBounds, [point]);
          return await dispatch(() => input.scroll([point.x, point.y], request.dx, request.dy));
        }
        case "typeFocused": {
          const window = requireWindow(request.window);
          const input = requireInput();
          await bringToFront(window.element, window.pid);
          return await dispatch(() => input.typeText(request.text));
        }
        case "press": {
          const entry = await requireIdentity(request.element, request.expect);
          return await dispatch(async () => {
            try {
              await entry.element.press();
              return;
            } catch (error) {
              if (errorName(error) !== "ActionNotSupportedError") throw error;
            }
            // No accessible press: click its centre, but only once its
            // window is verifiably in front.
            if (!entry.element.bounds) {
              throw new Refusal(failure("failed", "The element cannot be pressed."));
            }
            await bringToFront(windowOf(entry).element, entry.pid);
            await requireInput().click(entry.element);
          });
        }
        case "setValue": {
          const entry = await requireIdentity(request.element, request.expect);
          return await dispatch(() => entry.element.setValue(request.value));
        }
        case "typeText": {
          const entry = await requireIdentity(request.element, request.expect);
          return await dispatch(async () => {
            try {
              await entry.element.typeText(request.text);
              return;
            } catch (error) {
              if (errorName(error) !== "ActionNotSupportedError") throw error;
            }
            // No accessible text insertion: focus the element and type.
            await bringToFront(windowOf(entry).element, entry.pid);
            await beforeDispatch(() => entry.element.focus());
            await requireInput().typeText(request.text);
          });
        }
        case "key": {
          const window = requireWindow(request.window);
          const chord = translateKeyChord(request.keys, platform);
          if (!chord) return failure("failed", "Unsupported key chord.");
          const input = requireInput();
          await bringToFront(window.element, window.pid);
          return await dispatch(() =>
            chord.held.length === 0
              ? input.press(chord.key)
              : input.chord(chord.key, [...chord.held]),
          );
        }
        case "scroll": {
          const entry = await requireIdentity(request.element, request.expect);
          const input = requireInput();
          await bringToFront(windowOf(entry).element, entry.pid);
          return await dispatch(() => input.scroll(entry.element, request.dx, request.dy));
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
