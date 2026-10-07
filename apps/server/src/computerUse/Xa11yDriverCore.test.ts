// @effect-diagnostics nodeBuiltinImport:off - loads the native xa11y test fixture through require, as the worker does.
import * as NodeModule from "node:module";
import * as NodeZlib from "node:zlib";

import type { App, InputSim, Screenshot } from "@crowecawcaw/xa11y";
import { describe, expect, it } from "vite-plus/test";

import { downscaleRgba, encodePng, fitWithin } from "./ScreenshotImage.ts";
import {
  boundsMatch,
  classifyXa11yError,
  clipValue,
  isSecureElement,
  makeDriverCore,
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
  options: { readonly foregroundPid?: number | null; readonly screenshotDenied?: boolean } = {},
) => {
  const sent: Array<readonly [string, ...unknown[]]> = [];
  const written: Uint8Array[] = [];
  const input = {
    click: async (target: unknown, clickOptions?: unknown) =>
      void sent.push(Array.isArray(target) ? ["click", target, clickOptions] : ["click"]),
    drag: async (from: unknown, to: unknown) => void sent.push(["drag", from, to]),
    moveTo: async (target: unknown) => void sent.push(["moveTo", target]),
    press: async (key: string) => void sent.push(["press", key]),
    chord: async (key: string, held?: string[] | null) => void sent.push(["chord", key, held]),
    scroll: async (_target: unknown, dx?: number | null, dy?: number | null) =>
      void sent.push(["scroll", dx, dy]),
    typeText: async (text: string) => void sent.push(["typeText", text]),
  } as unknown as InputSim;
  // The native test app lacks the JS wrapper's `subscribe` overrides, which the driver never uses.
  const app = xa11y._makeTestApp() as unknown as App;
  const api: Xa11yApi = {
    listApps: async () => [app],
    appWindows: async () => app.children(),
    foregroundPid: async () =>
      options.foregroundPid === undefined ? TEST_PID : options.foregroundPid,
    inputSim: () => input,
    screenshot: async () => {
      if (!options.screenshotDenied) return retinaShot;
      throw Object.assign(new Error("denied"), { name: "PermissionDeniedError" });
    },
    executablePaths: async (pids) => new Map(pids.map((pid) => [pid, `/apps/${pid}`])),
    writeFile: async (_path, bytes) => void written.push(bytes),
    activateApp: async () => undefined,
    primaryDisplay: async () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    sleep: async () => undefined,
  };
  const core = makeDriverCore(api, { platform: "darwin", epoch: "t" });
  const call = async (request: DriverRequest) => core.handle(request);
  const firstWindow = async () => {
    const reply = await call({ op: "listWindows" });
    if (!reply.ok) throw new Error("listWindows failed");
    return (reply.result as ReadonlyArray<{ readonly handle: string }>)[0]!;
  };
  const observe = async (window: string, maxElements = 100) => {
    const reply = await call({ op: "observe", window, maxElements });
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
  return { call, sent, written, firstWindow, observe };
};

describe("driver core over the xa11y test app", () => {
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
    ).toEqual({ ok: true, result: null });
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
      result: null,
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
    const harness = makeHarness({ screenshotDenied: true });
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

  it("downscales a Retina capture and reports the logical bounds it covers", async () => {
    const harness = makeHarness();
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

    expect(await click({ ...WINDOW_BOUNDS, x: 102 })).toEqual({ ok: true, result: null });
    expect(harness.sent).toEqual([["click", [300, 200], { button: "right", count: 2 }]]);

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
      ["typeText", "abc"],
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
  it("tolerates two points of drift in window bounds", () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    expect(boundsMatch(rect, { x: 12, y: 18, width: 302, height: 198 })).toBe(true);
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
