// @effect-diagnostics nodeBuiltinImport:off - loads the native xa11y test fixture through require, as the worker does.
import * as NodeModule from "node:module";
import * as NodeZlib from "node:zlib";

import type { App, InputSim, Screenshot } from "@crowecawcaw/xa11y";
import { describe, expect, it, vi } from "vite-plus/test";

import { downscaleRgba, encodePng, fitWithin } from "./ScreenshotImage.ts";
import {
  boundsMatch,
  classifyXa11yError,
  clipValue,
  isSecureElement,
  makeDriverCore,
  placeObservedElements,
  smallestContaining,
  translateKeyChord,
  VALUE_MAX_CHARS,
  type DriverRequest,
  type Xa11yApi,
} from "./Xa11yDriverCore.ts";

type Xa11yModule = typeof import("@crowecawcaw/xa11y");

// xa11y's synthetic `TestApp` (pid 1234) runs the real Element code paths
// without a display: Main Window > toolbar Navigation [Back, Forward],
// group Content [text_field Search="hello", check_box Agree, slider Volume,
// static_text Status, list Items [Item 1, Item 2]].
const xa11y = NodeModule.createRequire(import.meta.url)("@crowecawcaw/xa11y") as Xa11yModule;
const TEST_PID = 1234;

const WINDOW_BOUNDS = { x: 100, y: 50, width: 800, height: 600 };

/** A Retina-like capture of the 800x600-point window: 1600x1200 pixels. */
const retinaShot = {
  width: 1600,
  height: 1200,
  scale: 2,
  pixels: new Uint8Array(1600 * 1200 * 4).fill(200),
  toPng: () => Buffer.from("full-size"),
} as unknown as Screenshot;

const pngSize = (png: Uint8Array) => {
  const buffer = Buffer.from(png);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const makeHarness = (
  options: {
    readonly foregroundPid?: number | null | (() => number | null);
    readonly platform?: NodeJS.Platform;
    readonly receiveText?: (text: string) => Promise<void>;
    readonly captureWindow?: Xa11yApi["captureWindow"];
    readonly now?: () => number;
  } = {},
) => {
  const sent: Array<readonly [string, ...unknown[]]> = [];
  const written: Uint8Array[] = [];
  const input = {
    click: async (target: unknown, clickOptions?: unknown) =>
      void sent.push(Array.isArray(target) ? ["click", target, clickOptions] : ["click"]),
    moveTo: async (target: unknown) => void sent.push(["moveTo", target]),
    press: async (key: string) => void sent.push(["press", key]),
    chord: async (key: string, held?: string[] | null) => void sent.push(["chord", key, held]),
    scroll: async (_target: unknown, dx?: number | null, dy?: number | null) =>
      void sent.push(["scroll", dx, dy]),
    typeText: async (text: string) => {
      sent.push(["typeText", text]);
      await options.receiveText?.(text);
    },
  } as unknown as InputSim;
  // The native test app lacks the JS wrapper's `subscribe` overrides, which the driver never uses.
  const app = xa11y._makeTestApp() as unknown as App;
  const api: Xa11yApi = {
    listApps: async () => [app],
    appWindows: async () => app.children(),
    elementIsAlive: async () => true,
    foregroundPid: async () =>
      typeof options.foregroundPid === "function"
        ? options.foregroundPid()
        : options.foregroundPid === undefined
          ? TEST_PID
          : options.foregroundPid,
    inputSim: () => input,
    pointerDrag: async (from, to) => void sent.push(["drag", [from.x, from.y], [to.x, to.y]]),
    releaseMouse: async () => void sent.push(["releaseMouse"]),
    enableAccessibility: async () => false,
    secondsSinceInput: async () => null,
    captureWindow: options.captureWindow ?? (async () => null),
    screenshot: async () => retinaShot,
    executablePaths: async (pids) => new Map(pids.map((pid) => [pid, `/apps/${pid}`])),
    writeFile: async (_path, bytes) => void written.push(bytes),
    activateApp: async () => undefined,
    primaryDisplay: async () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    sleep: async () => undefined,
    now: options.now ?? (() => 0),
    authorizeInput: async () => undefined,
  };
  const core = makeDriverCore(api, { platform: options.platform ?? "darwin", epoch: "t" });
  const call = async (request: DriverRequest) => core.handle(request);
  const firstWindow = async () => {
    const reply = await call({ op: "listWindows" });
    if (!reply.ok) throw new Error("listWindows failed");
    return (reply.result as ReadonlyArray<{ readonly handle: string }>)[0]!;
  };
  const observe = async (window: string, maxElements = 100, query?: string) => {
    const reply = await call({
      op: "observe",
      window,
      maxElements,
      ...(query !== undefined ? { query } : {}),
    });
    if (!reply.ok) throw new Error("observe failed");
    return reply.result as {
      readonly elements: ReadonlyArray<{
        readonly handle: string;
        readonly role: string;
        readonly label: string;
        readonly value?: string;
      }>;
      readonly truncated: boolean;
    };
  };
  return { call, sent, written, firstWindow, observe, api };
};

describe("driver core over the xa11y test app", () => {
  it("reports partial enumeration without losing readable apps or including error contents", async () => {
    const harness = makeHarness();
    const readable = await harness.api.listApps();
    const unreadable = {
      pid: 99,
      name: "PRIVATE APP",
      children: async () => {
        throw new Error("PRIVATE WINDOW VALUE");
      },
    } as unknown as App;
    const core = makeDriverCore(
      {
        ...harness.api,
        listApps: async () => [...readable, unreadable],
      },
      { platform: "darwin", epoch: "diagnostic" },
    );
    const result = await core.handle({ op: "listWindows" });
    expect(result).toMatchObject({
      ok: true,
      diagnostics: { windowEnumerationFailures: 1 },
    });
    if (!result.ok) throw new Error("list failed");
    expect((result.result as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("lists windows with a handle that survives relisting", async () => {
    const harness = makeHarness();
    const first = await harness.call({ op: "listWindows" });
    const second = await harness.call({ op: "listWindows" });
    expect(first).toEqual({
      ok: true,
      result: [
        {
          handle: expect.any(String),
          app: "TestApp",
          pid: TEST_PID,
          title: "Main Window",
          focused: true,
          bounds: { x: 100, y: 50, width: 800, height: 600 },
          appIdentifier: `/apps/${TEST_PID}`,
        },
      ],
    });
    expect(second).toEqual(first);
  });

  it("observes labelled and actionable elements in reading order", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const { elements, truncated } = await harness.observe(window.handle);
    expect(truncated).toBe(false);
    expect(elements.map(({ role, label, value }) => [role, label, value])).toEqual([
      ["toolbar", "Navigation", undefined],
      ["button", "Back", undefined],
      ["button", "Forward", undefined],
      ["group", "Content", undefined],
      ["text_field", "Search", "hello"],
      ["check_box", "Agree", undefined],
      ["slider", "Volume", "75"],
      ["static_text", "Status", "Loading..."],
      ["list", "Items", undefined],
      ["list_item", "Item 1", undefined],
      ["list_item", "Item 2", undefined],
    ]);
  });

  it("caps an observation breadth-first and says it was truncated", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const { elements, truncated } = await harness.observe(window.handle, 3);
    expect(truncated).toBe(true);
    expect(elements.map((element) => element.label)).toEqual(["Navigation", "Back", "Content"]);
  });

  it("finds a queried control past the cap, because the query is matched while reading", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    // A cap of 3 alone stops at Navigation, Back and Content.
    const { elements, truncated } = await harness.observe(window.handle, 3, "item 2");
    expect(truncated).toBe(false);
    expect(elements.map((element) => element.label)).toEqual(["Item 2"]);
  });

  it("acts only when the element still has the observed identity", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const { elements } = await harness.observe(window.handle);
    const search = elements.find((element) => element.label === "Search")!;

    expect(
      await harness.call({
        op: "setValue",
        element: search.handle,
        expect: { role: "text_field", label: "Search" },
        value: "x",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await harness.call({
        op: "press",
        element: search.handle,
        expect: { role: "text_field", label: "Query" },
      }),
    ).toEqual({
      ok: false,
      error: { kind: "stale", message: expect.any(String), dispatched: "no" },
    });
    expect(
      await harness.call({ op: "press", element: "e999", expect: { role: "button", label: "x" } }),
    ).toMatchObject({ ok: false, error: { kind: "stale", dispatched: "no" } });
  });

  it("clicks an unsupported ref instead of invoking a silent native press", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const search = (await harness.observe(window.handle)).elements.find(
      (element) => element.label === "Search",
    )!;
    const nativePress = vi.spyOn(xa11y.Element.prototype, "press").mockResolvedValue(undefined);
    try {
      expect(
        await harness.call({
          op: "press",
          element: search.handle,
          expect: { role: search.role, label: search.label },
        }),
      ).toMatchObject({ ok: true, result: { tookFocus: true } });
      expect(harness.sent).toEqual([["click"]]);
      expect(nativePress).not.toHaveBeenCalled();
    } finally {
      nativePress.mockRestore();
    }
  });

  it("refuses an unsupported background ref without invoking press or taking focus", async () => {
    const harness = makeHarness({ foregroundPid: TEST_PID + 1 });
    const activate = vi.fn(async () => undefined);
    const core = makeDriverCore(
      { ...harness.api, activateApp: activate },
      { platform: "darwin", epoch: "background-press", background: true },
    );
    const windows = await core.handle({ op: "listWindows" });
    if (!windows.ok) throw new Error("list failed");
    const window = (windows.result as ReadonlyArray<{ handle: string }>)[0]!;
    const observation = await core.handle({
      op: "observe",
      window: window.handle,
      maxElements: 100,
    });
    if (!observation.ok) throw new Error("observe failed");
    const search = (
      observation.result as {
        elements: ReadonlyArray<{ handle: string; role: string; label: string }>;
      }
    ).elements.find((element) => element.label === "Search")!;
    const nativePress = vi.spyOn(xa11y.Element.prototype, "press").mockResolvedValue(undefined);
    try {
      expect(
        await core.handle({
          op: "press",
          element: search.handle,
          expect: { role: search.role, label: search.label },
        }),
      ).toMatchObject({ ok: false, error: { kind: "unavailable", dispatched: "no" } });
      expect(activate).not.toHaveBeenCalled();
      expect(harness.sent).toEqual([]);
      expect(nativePress).not.toHaveBeenCalled();
    } finally {
      nativePress.mockRestore();
    }
  });

  it("forgets a window's handles when it is observed again", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const old = (await harness.observe(window.handle)).elements[1]!;
    await harness.observe(window.handle);
    expect(
      await harness.call({
        op: "press",
        element: old.handle,
        expect: { role: old.role, label: old.label },
      }),
    ).toMatchObject({ ok: false, error: { kind: "stale", dispatched: "no" } });
  });

  it("sends a key chord only once the window's app is in front", async () => {
    const front = makeHarness();
    const window = await front.firstWindow();
    expect(await front.call({ op: "key", window: window.handle, keys: "cmd+shift+z" })).toEqual({
      ok: true,
      result: { tookFocus: true },
    });
    expect(front.sent).toEqual([["chord", "z", ["Meta", "Shift"]]]);

    const behind = makeHarness({ foregroundPid: 99 });
    const other = await behind.firstWindow();
    expect(await behind.call({ op: "key", window: other.handle, keys: "enter" })).toMatchObject({
      ok: false,
      error: { kind: "failed", dispatched: "no" },
    });
    expect(behind.sent).toEqual([]);
  });

  it("maps a denied screenshot to the Screen Recording permission", async () => {
    const harness = makeHarness({
      captureWindow: async () => {
        throw Object.assign(new Error("denied"), { name: "PermissionDeniedError" });
      },
    });
    const window = await harness.firstWindow();
    expect(
      await harness.call({
        op: "screenshot",
        window: window.handle,
        outputPath: "/tmp/x.png",
        maxSize: 1568,
      }),
    ).toMatchObject({ ok: false, error: { kind: "permission-screen", dispatched: "no" } });
  });

  it("isolates macOS windows even when accessibility reports them as frontmost", async () => {
    const harness = makeHarness({ captureWindow: async () => ({ width: 1000, height: 750 }) });
    const window = await harness.firstWindow();
    expect(
      await harness.call({
        op: "screenshot",
        window: window.handle,
        outputPath: "/tmp/x.png",
        maxSize: 1000,
      }),
    ).toEqual({ ok: true, result: { width: 1000, height: 750, bounds: WINDOW_BOUNDS } });
    // Region capture writes these bytes, so none means no screen-region fallback.
    expect(harness.written).toEqual([]);
  });

  it.each([true, false])(
    "refuses a macOS capture without an isolated window (front=%s)",
    async (front) => {
      const harness = makeHarness({ foregroundPid: front ? TEST_PID : null });
      const window = await harness.firstWindow();
      expect(
        await harness.call({
          op: "screenshot",
          window: window.handle,
          outputPath: "/tmp/x.png",
          maxSize: 1000,
        }),
      ).toMatchObject({ ok: false, error: { kind: "failed", dispatched: "no" } });
      expect(harness.written).toEqual([]);
    },
  );

  it("does not return unrelated screen pixels when macOS window capture throws", async () => {
    const harness = makeHarness({
      captureWindow: async () => {
        throw new Error("capture unavailable");
      },
    });
    const window = await harness.firstWindow();
    expect(
      await harness.call({
        op: "screenshot",
        window: window.handle,
        outputPath: "/tmp/x.png",
        maxSize: 1000,
      }),
    ).toMatchObject({ ok: false, error: { kind: "failed", dispatched: "no" } });
    expect(harness.written).toEqual([]);
  });

  it("downscales a Retina capture and reports the logical bounds it covers", async () => {
    const harness = makeHarness({ platform: "linux" });
    const window = await harness.firstWindow();
    const shrunk = await harness.call({
      op: "screenshot",
      window: window.handle,
      outputPath: "/tmp/x.png",
      maxSize: 1000,
    });
    expect(shrunk).toEqual({
      ok: true,
      result: { width: 1000, height: 750, bounds: WINDOW_BOUNDS },
    });
    expect(pngSize(harness.written[0]!)).toEqual({ width: 1000, height: 750 });

    const full = await harness.call({
      op: "screenshot",
      window: window.handle,
      outputPath: "/tmp/x.png",
      maxSize: 2560,
    });
    expect(full).toEqual({
      ok: true,
      result: { width: 1600, height: 1200, bounds: WINDOW_BOUNDS },
    });
    expect(Buffer.from(harness.written[1]!).toString()).toBe("full-size");
  });

  it("clicks a screen point only while the window is where the screenshot saw it", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const click = (expectBounds: typeof WINDOW_BOUNDS, point = { x: 300, y: 200 }) =>
      harness.call({
        op: "click",
        window: window.handle,
        expectBounds,
        point,
        button: "right",
        count: 2,
      });

    expect(await click(WINDOW_BOUNDS)).toEqual({ ok: true, result: { tookFocus: true } });
    expect(harness.sent).toEqual([["click", [300, 200], { button: "right", count: 2 }]]);

    expect(await click({ ...WINDOW_BOUNDS, x: 102 })).toMatchObject({
      ok: false,
      error: { kind: "stale", dispatched: "no" },
    });

    expect(await click({ ...WINDOW_BOUNDS, width: 803 })).toMatchObject({
      ok: false,
      error: { kind: "stale", dispatched: "no" },
    });
    expect(await click(WINDOW_BOUNDS, { x: 950, y: 200 })).toMatchObject({
      ok: false,
      error: { kind: "failed", dispatched: "no" },
    });
    expect(harness.sent).toHaveLength(1);
  });

  it("drags, moves and scrolls at screen points", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    const base = { window: window.handle, expectBounds: WINDOW_BOUNDS };
    await harness.call({ op: "drag", ...base, from: { x: 150, y: 60 }, to: { x: 400, y: 300 } });
    await harness.call({ op: "move", ...base, point: { x: 150, y: 60 } });
    await harness.call({ op: "scrollAt", ...base, point: { x: 150, y: 60 }, dx: 0, dy: 4 });
    await harness.call({ op: "typeFocused", window: window.handle, text: "abc" });
    expect(harness.sent).toEqual([
      ["drag", [150, 60], [400, 300]],
      ["moveTo", [150, 60]],
      ["scroll", 0, 4],
      ["typeText", "a"],
      ["typeText", "b"],
      ["typeText", "c"],
    ]);
  });

  it("preserves complete Mac text when an app consumes one character per key event", async () => {
    let value = "";
    const harness = makeHarness({
      receiveText: async (text) => {
        // Model a receiver that consumes only the first code point of an event.
        value += [...text][0] ?? "";
      },
    });
    const window = await harness.firstWindow();
    const text = "Library/Application Support/🧪 e\u0301";
    expect(await harness.call({ op: "typeFocused", window: window.handle, text })).toMatchObject({
      ok: true,
      result: { tookFocus: true },
    });
    expect(value).toBe(text);
  });

  it("re-checks focus between characters only once the re-check interval passed", async () => {
    let checks = 0;
    const harness = makeHarness({
      foregroundPid: () => {
        checks += 1;
        return TEST_PID;
      },
    });
    const window = await harness.firstWindow();
    await harness.call({ op: "typeFocused", window: window.handle, text: "a long note" });
    const beforeTyping = checks;
    await harness.call({ op: "typeFocused", window: window.handle, text: "x".repeat(500) });
    // Activation and the dispatch check read focus a fixed number of times,
    // whatever the length: the clock never moves, so typing adds none.
    expect(checks - beforeTyping).toBe(beforeTyping);
    expect(harness.sent.filter(([kind]) => kind === "typeText")).toHaveLength(511);
  });

  it("keeps the batched native typing path on Linux", async () => {
    let value = "";
    const harness = makeHarness({
      platform: "linux",
      receiveText: async (text) => {
        value += text;
      },
    });
    const window = await harness.firstWindow();
    const text = "Library/🧪";
    await harness.call({ op: "typeFocused", window: window.handle, text });
    expect(value).toBe(text);
    expect(harness.sent).toEqual([["typeText", text]]);
  });

  it("stops Mac text when focus changes after a character, without reclaiming focus", async () => {
    let foreground = TEST_PID;
    let value = "";
    let clock = 0;
    const harness = makeHarness({
      foregroundPid: () => foreground,
      now: () => clock,
      receiveText: async (text) => {
        value += text;
        foreground = TEST_PID + 1;
        // Longer than the focus re-check interval.
        clock += 100;
      },
    });
    const window = await harness.firstWindow();
    expect(
      await harness.call({ op: "typeFocused", window: window.handle, text: "abc" }),
    ).toMatchObject({ ok: false, error: { kind: "failed", dispatched: "unknown" } });
    expect(value).toBe("a");
    expect(foreground).toBe(TEST_PID + 1);
    expect(harness.sent).toEqual([["typeText", "a"]]);
  });

  it.each(["PermissionDeniedError", "ActionNotSupportedError", "SelectorNotMatchedError"])(
    "reports partial Mac text as uncertain when a later event throws %s",
    async (name) => {
      let value = "";
      const harness = makeHarness({
        receiveText: async (text) => {
          if (text === "b") throw Object.assign(new Error("Native event refused"), { name });
          value += text;
        },
      });
      const window = await harness.firstWindow();
      expect(
        await harness.call({ op: "typeFocused", window: window.handle, text: "abc" }),
      ).toMatchObject({ ok: false, error: { dispatched: "unknown" } });
      expect(value).toBe("a");
      expect(harness.sent).toEqual([
        ["typeText", "a"],
        ["typeText", "b"],
      ]);
    },
  );

  it("does not replay or finish Mac text after uncertain partial native delivery", async () => {
    let value = "";
    const harness = makeHarness({
      receiveText: async (text) => {
        if (text === "b") throw new Error("Native input failed after an uncertain key event");
        value += text;
      },
    });
    const window = await harness.firstWindow();
    expect(
      await harness.call({ op: "typeFocused", window: window.handle, text: "abc" }),
    ).toMatchObject({
      ok: false,
      error: { dispatched: "unknown" },
    });
    expect(value).toBe("a");
    expect(harness.sent).toEqual([
      ["typeText", "a"],
      ["typeText", "b"],
    ]);
  });

  it("names the smallest labelled element under a point", async () => {
    const harness = makeHarness();
    const window = await harness.firstWindow();
    // Only the Search field has bounds in the test app: (200,120) 300x25.
    expect(
      await harness.call({ op: "elementAt", window: window.handle, point: { x: 250, y: 130 } }),
    ).toEqual({ ok: true, result: { role: "text_field", label: "Search" } });
    expect(
      await harness.call({ op: "elementAt", window: window.handle, point: { x: 600, y: 500 } }),
    ).toEqual({ ok: true, result: null });
  });
});

describe("pure helpers", () => {
  it("refuses any drift in window bounds", () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    expect(boundsMatch(rect, { ...rect })).toBe(true);
    expect(boundsMatch(rect, { x: 12, y: 18, width: 302, height: 198 })).toBe(false);
    expect(boundsMatch(rect, { ...rect, x: 10.5 })).toBe(false);
    expect(boundsMatch(rect, { ...rect, x: 13 })).toBe(false);
    expect(boundsMatch(rect, { ...rect, height: 197 })).toBe(false);
    expect(boundsMatch(rect, null)).toBe(false);
  });

  it.each([
    [2880, 1800, 1568, { width: 1568, height: 980 }],
    [1200, 2400, 1568, { width: 784, height: 1568 }],
    [1000, 700, 1568, { width: 1000, height: 700 }],
    [5000, 3, 256, { width: 256, height: 1 }],
  ])("fits %ix%i within %i", (width, height, maxSize, expected) => {
    expect(fitWithin(width, height, maxSize)).toEqual(expected);
  });

  it("averages source pixels when downscaling", () => {
    // 2x1 → 1x1: black and white average to mid grey.
    const source = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    expect([...downscaleRgba(source, 2, 1, 1, 1)]).toEqual([128, 128, 128, 255]);
  });

  it("encodes a PNG whose pixel data round-trips", () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const png = encodePng(pixels, 2, 1);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(pngSize(png)).toEqual({ width: 2, height: 1 });
    const idatLength = png.readUInt32BE(33);
    const raw = NodeZlib.inflateSync(png.subarray(41, 41 + idatLength));
    expect([...raw]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("picks the smallest labelled element containing a point", () => {
    const point = { x: 50, y: 50 };
    const picked = smallestContaining(
      [
        { label: "Window", bounds: { x: 0, y: 0, width: 500, height: 500 } },
        { label: "", bounds: { x: 40, y: 40, width: 20, height: 20 } },
        { label: "Toolbar", bounds: { x: 0, y: 0, width: 500, height: 100 } },
        { label: "Elsewhere", bounds: { x: 200, y: 200, width: 5, height: 5 } },
        { label: "No bounds", bounds: null },
      ],
      point,
    );
    expect(picked?.label).toBe("Toolbar");
    expect(smallestContaining([], point)).toBeUndefined();
  });

  it.each([
    ["enter", "darwin", { key: "Enter", held: [] }],
    ["return", "linux", { key: "Enter", held: [] }],
    ["cmd+a", "darwin", { key: "a", held: ["Meta"] }],
    ["cmd+a", "win32", { key: "a", held: ["Ctrl"] }],
    ["super+l", "linux", { key: "l", held: ["Meta"] }],
    ["option+shift+left", "darwin", { key: "ArrowLeft", held: ["Alt", "Shift"] }],
    ["alt+option+f4", "win32", { key: "F4", held: ["Alt"] }],
    ["ctrl+pagedown", "linux", { key: "PageDown", held: ["Ctrl"] }],
    ["hyper+a", "darwin", undefined],
    ["cmd+", "darwin", undefined],
  ] as const)("translates %s on %s", (chord, platform, expected) => {
    expect(translateKeyChord(chord, platform)).toEqual(expected);
  });

  it("clips long values", () => {
    expect(clipValue("short")).toBe("short");
    const clipped = clipValue("x".repeat(500));
    expect(clipped).toHaveLength(VALUE_MAX_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("recognises secure fields", () => {
    expect(
      isSecureElement({ raw: { ax_subrole: "AXSecureTextField" }, editable: true, label: "" }),
    ).toBe(true);
    expect(isSecureElement({ raw: { is_password: true }, editable: true, label: "" })).toBe(true);
    expect(isSecureElement({ raw: {}, editable: true, label: "Password" })).toBe(true);
    expect(isSecureElement({ raw: {}, editable: false, label: "Forgot password?" })).toBe(false);
    expect(
      isSecureElement({ raw: { ax_subrole: "AXSearchField" }, editable: true, label: "Search" }),
    ).toBe(false);
  });

  it("reports input that may have landed as dispatched-unknown", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(classifyXa11yError(named("PlatformError"), { afterDispatch: true }).dispatched).toBe(
      "unknown",
    );
    expect(classifyXa11yError(named("PlatformError"), { afterDispatch: false }).dispatched).toBe(
      "no",
    );
    expect(
      classifyXa11yError(named("ActionNotSupportedError"), { afterDispatch: true }),
    ).toMatchObject({
      kind: "failed",
      dispatched: "no",
    });
    expect(
      classifyXa11yError(named("PermissionDeniedError"), { afterDispatch: true }),
    ).toMatchObject({
      kind: "permission-accessibility",
      dispatched: "no",
    });
  });
});

describe("placeObservedElements", () => {
  const heading = (label: string, ...path: number[]) => ({ label, path });
  const control = (label: string, ...path: number[]) => ({ role: "button", label, path });

  it("names the nearest heading before each control and counts same-named controls", () => {
    const placed = placeObservedElements(
      [control("Next", 0, 2), control("Previous", 1, 0, 1), control("Next", 1, 0, 2)],
      [heading("Basic wizard", 0, 0), heading("Ajax Content Example", 1, 0, 0)],
    );
    expect(placed).toEqual([
      { section: "Basic wizard", instance: "1 of 2" },
      { section: "Ajax Content Example" },
      { section: "Ajax Content Example", instance: "2 of 2" },
    ]);
  });

  it("leaves out both when there is no heading before a unique control", () => {
    expect(placeObservedElements([control("Save", 0)], [heading("Later", 1)])).toEqual([{}]);
  });
});
