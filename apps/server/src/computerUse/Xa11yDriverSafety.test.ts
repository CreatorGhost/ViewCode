import type { App, Element, InputSim, Rect } from "@crowecawcaw/xa11y";
import type { ComputerUseError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVATION_TIMEOUT_MS,
  appBundlePath,
  makeDriverCore,
  type DriverRequest,
  type DriverResult,
  type Xa11yApi,
} from "./Xa11yDriverCore.ts";
import type { DriverDispatchPhase, DriverDispatchTarget } from "./ComputerDriver.ts";

// A mutable fake desktop. Like xa11y, `fake` copies properties when an
// element is fetched: an old element never sees later changes, only a fresh
// `children()` walk does. That is what makes stale-identity bugs visible.
interface Spec {
  role: string;
  name?: string;
  description?: string;
  stableId?: string | null;
  bounds?: Rect | null;
  actions?: string[];
  active?: boolean;
  focused?: boolean;
  pressUnsupported?: boolean;
  typeUnsupported?: boolean;
  value?: string;
  /** Accepts accessibility text changes without applying them, like Safari's web fields. */
  ignoresTextChanges?: boolean;
  /** Runs when the accessible press is attempted, before it fails or lands. */
  onPress?: () => void;
  onFocus?: () => Promise<void>;
  children?: Spec[];
}

type Sent = Array<readonly [string, ...unknown[]]>;

const notSupported = () => Object.assign(new Error("x"), { name: "ActionNotSupportedError" });

const snapshots = new WeakMap<Element, Spec>();

const fake = (spec: Spec, sent: Sent): Element => {
  const snapshot = {
    role: spec.role,
    name: spec.name ?? null,
    description: spec.description ?? null,
    stableId: spec.stableId ?? null,
    bounds: spec.bounds ? { ...spec.bounds } : null,
    actions: spec.actions ?? ["press"],
  };
  const element = {
    ...snapshot,
    value: spec.value ?? null,
    raw: {},
    editable: false,
    enabled: true,
    active: spec.active ?? false,
    focused: spec.focused ?? false,
    children: async () => (spec.children ?? []).map((child) => fake(child, sent)),
    tree: async () => ({ role: snapshot.role, name: snapshot.name ?? undefined, children: [] }),
    press: async () => {
      spec.onPress?.();
      if (spec.pressUnsupported) throw notSupported();
      sent.push(["press", snapshot.name]);
    },
    setValue: async (value: string) => {
      sent.push(["setValue", snapshot.name]);
      if (!spec.ignoresTextChanges) spec.value = value;
    },
    typeText: async (text: string) => {
      if (spec.typeUnsupported) throw notSupported();
      sent.push(["AXtype", snapshot.name, text]);
      if (!spec.ignoresTextChanges) spec.value = `${spec.value ?? ""}${text}`;
    },
    performAction: async () => undefined,
    focus: async () => {
      await spec.onFocus?.();
    },
  } as unknown as Element;
  snapshots.set(element, spec);
  return element;
};

const BOUNDS = { x: 0, y: 0, width: 500, height: 400 };

const window = (name: string, extra: Partial<Spec> = {}): Spec => ({
  role: "window",
  name,
  bounds: { ...BOUNDS },
  active: true,
  focused: true,
  actions: ["raise"],
  children: [],
  ...extra,
});

interface FakeApp {
  readonly name: string;
  readonly pid: number;
  windows: Spec[];
}

const makeCore = (
  apps: FakeApp[],
  options: {
    readonly epoch?: string;
    foreground?: number | null;
    readonly activate?: (pid: number) => void | Promise<void>;
    readonly primaryDisplay?: () => Rect | null;
    readonly capture?: Xa11yApi["screenshot"];
    readonly captureWindow?: Xa11yApi["captureWindow"];
    readonly executablePaths?: Xa11yApi["executablePaths"];
    /** The server's check; allows everything unless given. */
    readonly authorize?: (
      target: DriverDispatchTarget,
      phase: DriverDispatchPhase,
    ) => ComputerUseError | undefined;
    readonly clock?: { now: number };
    readonly sleep?: (ms: number) => Promise<void>;
    readonly receiveText?: (text: string) => void;
  } = {},
) => {
  const sent: Sent = [];
  const calls = { activate: 0, primaryDisplay: 0 };
  const input = {
    press: async (key: string) => void sent.push(["key", key]),
    chord: async (key: string, held: string[]) => void sent.push(["chord", key, held]),
    typeText: async (text: string) => {
      sent.push(["typeText", text]);
      options.receiveText?.(text);
    },
    click: async (target: unknown) =>
      void sent.push(["click", Array.isArray(target) ? target : (target as Element).bounds]),
    scroll: async (target: Element) => void sent.push(["scroll", target.bounds]),
  } as unknown as InputSim;
  const asApp = (app: FakeApp) =>
    ({
      name: app.name,
      pid: app.pid,
      isForeground: true,
      children: async () => app.windows.map((spec) => fake(spec, sent)),
    }) as unknown as App;
  const api: Xa11yApi = {
    listApps: async () => apps.map(asApp),
    appWindows: async (pid) => {
      const app = apps.find((candidate) => candidate.pid === pid);
      return app ? app.windows.map((spec) => fake(spec, sent)) : [];
    },
    // Like a retained AXUIElement: alive while that exact object is in the tree.
    elementIsAlive: async (element) => {
      const target = snapshots.get(element);
      const inTree = (specs: Spec[]): boolean =>
        specs.some((spec) => spec === target || inTree(spec.children ?? []));
      return apps.some((app) => inTree(app.windows));
    },
    foregroundPid: async () =>
      options.foreground === undefined ? (apps[0]?.pid ?? null) : options.foreground,
    inputSim: () => input,
    pointerDrag: async (from, to) => void sent.push(["drag", from, to]),
    releaseMouse: async () => void sent.push(["mouseUp", "left"]),
    captureWindow: options.captureWindow ?? (async () => null),
    screenshot:
      options.capture ??
      (async () => {
        throw new Error("no capture in these tests");
      }),
    executablePaths: options.executablePaths ?? (async () => new Map()),
    writeFile: async () => undefined,
    activateApp: async (pid) => {
      calls.activate += 1;
      await options.activate?.(pid);
    },
    primaryDisplay: async () => {
      calls.primaryDisplay += 1;
      return options.primaryDisplay?.() ?? null;
    },
    sleep: options.sleep ?? (async () => undefined),
    now: () => options.clock?.now ?? 0,
    authorizeInput: async (target, phase) => options.authorize?.(target, phase),
  };
  const core = makeDriverCore(api, { platform: "darwin", epoch: options.epoch ?? "a" });
  const call = (request: DriverRequest) => core.handle(request);
  const list = async () =>
    ((await call({ op: "listWindows" })) as { result: Array<{ handle: string; title: string }> })
      .result;
  const observe = async (window: string) =>
    (
      (await call({ op: "observe", window, maxElements: 50 })) as {
        result: { elements: Array<{ handle: string; role: string; label: string }> };
      }
    ).result.elements;
  return { call, list, observe, sent, calls };
};

const staleNo = { ok: false, error: { kind: "stale", dispatched: "no" } };
const refusedNo = { ok: false, error: { kind: "failed", dispatched: "no" } };
const ok: DriverResult = { ok: true, result: null };
/** Input that brought the window to the front. */
const focused: DriverResult = { ok: true, result: { tookFocus: true } };
/** An accessibility action that ran in the background. */
const inBackground: DriverResult = { ok: true, result: { tookFocus: false } };

describe("handles never outlive their worker", () => {
  it("does not let a handle from a replaced worker name another app's window", async () => {
    const textEdit: FakeApp = { name: "TextEdit", pid: 10, windows: [window("notes")] };
    const passwords: FakeApp = { name: "1Password", pid: 20, windows: [window("Vault")] };
    const before = makeCore([textEdit], { epoch: "old" });
    const [old] = await before.list();

    const after = makeCore([passwords, textEdit], { epoch: "new", foreground: 20 });
    await after.list();
    expect(await after.call({ op: "key", window: old!.handle, keys: "enter" })).toMatchObject(
      staleNo,
    );
    expect(after.sent).toEqual([]);
  });

  // The server forwards this message; "the window closed" would be a lie.
  it("says the driver restarted for handles minted by an earlier worker", async () => {
    const app: FakeApp = {
      name: "Mail",
      pid: 7,
      windows: [window("Inbox", { children: [{ role: "button", name: "Archive" }] })],
    };
    const before = makeCore([app], { epoch: "old" });
    const [inbox] = await before.list();
    const [archive] = await before.observe(inbox!.handle);

    const after = makeCore([app], { epoch: "new" });
    const [current] = await after.list();
    expect(await after.call({ op: "observe", window: inbox!.handle, maxElements: 5 })).toEqual({
      ok: false,
      error: {
        kind: "stale",
        message: "The computer-use driver restarted; list windows again.",
        dispatched: "no",
        reason: "restarted",
      },
    });
    expect(
      await after.call({
        op: "press",
        element: archive!.handle,
        expect: { role: "button", label: "Archive" },
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "stale",
        message: "The computer-use driver restarted; observe again.",
        dispatched: "no",
        reason: "restarted",
      },
    });
    expect(after.sent).toEqual([]);
    // A handle this worker minted and forgot is still just unknown.
    await after.observe(current!.handle);
    app.windows = [];
    await after.list();
    expect(await after.call({ op: "key", window: current!.handle, keys: "enter" })).toMatchObject({
      ok: false,
      error: { kind: "stale", message: "Unknown window; list windows again." },
    });
    const unknown = await after.call({ op: "key", window: current!.handle, keys: "enter" });
    expect(!unknown.ok && unknown.error.reason).toBeUndefined();
  });
});

describe("refs act on the live element", () => {
  const appWith = (row: Spec): FakeApp => ({
    name: "Mail",
    pid: 7,
    windows: [window("Inbox", { children: [{ role: "list", name: "Messages", children: [row] }] })],
  });

  it("refuses when a different control now sits where the observed one was", async () => {
    const app = appWith({ role: "button", name: "Archive" });
    const core = makeCore([app]);
    const [inbox] = await core.list();
    const archive = (await core.observe(inbox!.handle)).find((e) => e.label === "Archive")!;
    // The row re-rendered: same place in the tree, different control.
    app.windows[0]!.children![0]!.children![0] = { role: "button", name: "Delete" };

    expect(
      await core.call({
        op: "press",
        element: archive.handle,
        expect: { role: "button", label: "Archive" },
      }),
    ).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  it("refuses a moved element even when its role and label still match", async () => {
    const row: Spec = {
      role: "cell",
      name: "Row 3",
      pressUnsupported: true,
      bounds: { x: 10, y: 10, width: 50, height: 20 },
    };
    const app = appWith(row);
    const core = makeCore([app]);
    const [inbox] = await core.list();
    const cell = (await core.observe(inbox!.handle)).find((e) => e.label === "Row 3")!;
    row.bounds = { x: 10, y: 200, width: 50, height: 20 }; // scrolled within the window

    expect(
      await core.call({
        op: "press",
        element: cell.handle,
        expect: { role: "cell", label: "Row 3" },
      }),
    ).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  it("refuses refs once their window moved", async () => {
    const app = appWith({ role: "button", name: "Archive" });
    const core = makeCore([app]);
    const [inbox] = await core.list();
    const archive = (await core.observe(inbox!.handle))[1]!;
    app.windows[0]!.bounds = { ...BOUNDS, x: 300 };
    expect(
      await core.call({
        op: "press",
        element: archive.handle,
        expect: { role: "button", label: "Archive" },
      }),
    ).toMatchObject(staleNo);
  });

  it("matches long labels in full while the agent sees them clipped", async () => {
    const long = `Open ${"x".repeat(300)}`;
    const core = makeCore([appWith({ role: "button", name: long })]);
    const [inbox] = await core.list();
    const button = (await core.observe(inbox!.handle)).find((e) => e.role === "button")!;
    expect(button.label.length).toBe(200);
    expect(
      await core.call({
        op: "press",
        element: button.handle,
        expect: { role: "button", label: button.label },
      }),
    ).toEqual(inBackground);
    expect(core.sent).toEqual([["press", long]]);
  });
});

describe("input goes only to the exact target window", () => {
  it("activates the app when another app is in front", async () => {
    const options: { foreground: number | null; activate: (pid: number) => void } = {
      foreground: 99, // ViewCode
      activate: (pid) => void (options.foreground = pid),
    };
    const core = makeCore([{ name: "Notes", pid: 5, windows: [window("Note")] }], options);
    const [note] = await core.list();
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toEqual(focused);
    expect(core.calls.activate).toBe(1);
    expect(core.sent).toEqual([["key", "Enter"]]);
  });

  it("refuses when a sibling window of the same app is the active one", async () => {
    const app: FakeApp = {
      name: "Notes",
      pid: 5,
      windows: [
        window("Draft", { active: false, focused: false, bounds: { ...BOUNDS, x: 600 } }),
        window("Other"),
      ],
    };
    const core = makeCore([app]);
    const [draft] = await core.list();
    expect(await core.call({ op: "typeFocused", window: draft!.handle, text: "hi" })).toMatchObject(
      refusedNo,
    );
    expect(core.sent).toEqual([]);
  });

  it("refuses key input to a window that has closed", async () => {
    const app: FakeApp = { name: "Notes", pid: 5, windows: [window("Note")] };
    const core = makeCore([app]);
    const [note] = await core.list();
    app.windows = [];
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toMatchObject(
      staleNo,
    );
    expect(core.sent).toEqual([]);
  });
});

describe("window identity fails closed", () => {
  const click = (handle: string) =>
    ({
      op: "click",
      window: handle,
      expectBounds: BOUNDS,
      point: { x: 10, y: 10 },
      button: "left",
      count: 1,
    }) as const;

  it("does not merge windows that share a reused native id", async () => {
    const core = makeCore([
      {
        name: "TextEdit",
        pid: 42,
        windows: [
          window("Doc A", { stableId: "MainWindow" }),
          window("Doc B", { stableId: "MainWindow", bounds: { ...BOUNDS, x: 600 } }),
        ],
      },
    ]);
    const listed = await core.list();
    expect(new Set(listed.map((w) => w.handle)).size).toBe(2);
  });

  it("does not hand a closed window's handle to a new window at the same spot", async () => {
    const app: FakeApp = { name: "Browser", pid: 3, windows: [window("Gmail")] };
    const core = makeCore([app]);
    const [gmail] = await core.list();
    app.windows = [window("Bank")];
    expect(await core.call(click(gmail!.handle))).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  it("never matches a window with a native id by place or title", async () => {
    const app: FakeApp = { name: "Editor", pid: 3, windows: [window("Doc", { stableId: "A" })] };
    const core = makeCore([app]);
    const [doc] = await core.list();
    app.windows = [window("Doc", { stableId: "B" })];
    expect(await core.call(click(doc!.handle))).toMatchObject(staleNo);
  });

  it("keeps a window's handle when only its title changed", async () => {
    const doc = window("Untitled");
    const app: FakeApp = { name: "Blender", pid: 3, windows: [doc] };
    const core = makeCore([app]);
    const [before] = await core.list();
    doc.name = "scene.blend";
    const [after] = await core.list();
    expect(after).toMatchObject({ handle: before!.handle, title: "scene.blend" });
    expect(await core.call(click(before!.handle))).toMatchObject({ ok: true });
  });

  it("does not follow a retitled window when another window sits at the same spot", async () => {
    const doc = window("Untitled");
    const app: FakeApp = { name: "Blender", pid: 3, windows: [doc, window("Preferences")] };
    const core = makeCore([app]);
    const [before] = await core.list();
    doc.name = "scene.blend";
    expect(await core.call(click(before!.handle))).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  it("refuses a same-titled window that is no longer where it was", async () => {
    const app: FakeApp = {
      name: "Editor",
      pid: 3,
      windows: [window("Untitled"), window("Untitled", { bounds: { ...BOUNDS, x: 600 } })],
    };
    const core = makeCore([app]);
    const [first] = await core.list();
    app.windows = [window("Untitled", { bounds: { ...BOUNDS, x: 600 } })]; // the first closed
    expect(await core.call({ op: "key", window: first!.handle, keys: "enter" })).toMatchObject(
      staleNo,
    );
    expect(core.sent).toEqual([]);
  });
});

describe("accessibility text changes are checked", () => {
  const setup = (field: Spec, options: Parameters<typeof makeCore>[1] = {}) => {
    const notes = window("Notes", { children: [field], active: false, focused: false });
    const core = makeCore([{ name: "Safari", pid: 12, windows: [notes] }], {
      ...options,
      activate: () => {
        notes.active = notes.focused = true;
      },
    });
    return core;
  };
  const target = { role: "text field", label: "Search" };

  it("keeps a change that showed up in the field's value, in the background", async () => {
    const core = setup({ role: "text field", name: "Search", value: "" });
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    expect(
      await core.call({ op: "typeText", element: ref!.handle, expect: target, text: "hi" }),
    ).toEqual({ ok: true, result: { tookFocus: false } });
    expect(core.sent).toEqual([["AXtype", "Search", "hi"]]);
    expect(core.calls.activate).toBe(0);
  });

  it("types by keyboard when an accepted insertion left the value unchanged", async () => {
    const core = setup({ role: "text field", name: "Search", value: "", ignoresTextChanges: true });
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    expect(
      await core.call({ op: "typeText", element: ref!.handle, expect: target, text: "hi" }),
    ).toEqual({ ok: true, result: { tookFocus: true } });
    expect(core.sent).toEqual([
      ["AXtype", "Search", "hi"],
      ["typeText", "h"],
      ["typeText", "i"],
    ]);
  });

  it("replaces the contents by keyboard when an accepted value did not take", async () => {
    const core = setup({
      role: "text field",
      name: "Search",
      value: "old",
      ignoresTextChanges: true,
    });
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    expect(
      await core.call({ op: "setValue", element: ref!.handle, expect: target, value: "ok" }),
    ).toEqual({ ok: true, result: { tookFocus: true } });
    expect(core.sent).toEqual([
      ["setValue", "Search"],
      ["chord", "a", ["Meta"]],
      ["typeText", "o"],
      ["typeText", "k"],
    ]);
  });

  it("reports an ignored change as uncertain when the keyboard fallback is refused", async () => {
    let prepares = 0;
    const core = setup(
      { role: "text field", name: "Search", value: "", ignoresTextChanges: true },
      {
        authorize: (_target, phase) => {
          if (phase === "prepare") prepares += 1;
          return prepares > 1
            ? { code: "CU-CON-008", message: "paused", effect: "not-dispatched" }
            : undefined;
        },
      },
    );
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    expect(
      await core.call({ op: "typeText", element: ref!.handle, expect: target, text: "hi" }),
    ).toMatchObject({ ok: false, error: { kind: "policy", dispatched: "unknown" } });
    expect(core.sent).toEqual([["AXtype", "Search", "hi"]]);
  });
});

describe("screenshots and the mouse", () => {
  it("refuses windows that are not fully on the primary display", async () => {
    const display = { x: 0, y: 0, width: 400, height: 900 };
    const core = makeCore([{ name: "Notes", pid: 5, windows: [window("Note")] }], {
      primaryDisplay: () => display,
    });
    const [note] = await core.list();
    expect(
      await core.call({
        op: "screenshot",
        window: note!.handle,
        outputPath: "/tmp/x.png",
        maxSize: 800,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "failed",
        message: "The window is not fully on the main display; move it there.",
      },
    });
    expect(core.calls.primaryDisplay).toBe(1);
  });

  it("captures only a window's own pixels when it is behind another", async () => {
    const note = window("Note", { active: false, focused: false });
    const captured: Array<readonly [number, Rect, number]> = [];
    const core = makeCore([{ name: "Notes", pid: 5, windows: [note] }], {
      primaryDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      captureWindow: async (pid, bounds, _path, maxSize) => {
        captured.push([pid, bounds, maxSize]);
        return { width: 400, height: 320 };
      },
    });
    const [win] = await core.list();
    expect(
      await core.call({
        op: "screenshot",
        window: win!.handle,
        outputPath: "/x.png",
        maxSize: 400,
      }),
    ).toEqual({ ok: true, result: { width: 400, height: 320, bounds: BOUNDS } });
    expect(captured).toEqual([[5, BOUNDS, 400]]);
  });

  it("refuses a covered window's capture when Screen Recording is missing", async () => {
    const note = window("Note", { active: false, focused: false });
    const core = makeCore([{ name: "Notes", pid: 5, windows: [note] }], {
      primaryDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      captureWindow: async () => {
        throw Object.assign(new Error("denied"), { name: "PermissionDeniedError" });
      },
    });
    const [win] = await core.list();
    expect(
      await core.call({
        op: "screenshot",
        window: win!.handle,
        outputPath: "/x.png",
        maxSize: 400,
      }),
    ).toMatchObject({ ok: false, error: { kind: "permission-screen" } });
  });

  it("releases the left mouse button on request", async () => {
    const core = makeCore([]);
    expect(await core.call({ op: "releaseMouse" })).toEqual(ok);
    expect(core.sent).toEqual([["mouseUp", "left"]]);
  });

  it("finds the app bundle to activate", () => {
    expect(appBundlePath("/Applications/Foo Bar.app/Contents/MacOS/Foo Bar")).toBe(
      "/Applications/Foo Bar.app",
    );
    expect(
      appBundlePath(
        "/Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper",
      ),
    ).toBe("/Applications/Foo.app/Contents/Frameworks/Foo Helper.app");
    expect(appBundlePath("/usr/bin/vim")).toBeUndefined();
  });
});

describe("Native target audit regressions", () => {
  it("refuses a replacement window without needing an empty listing", async () => {
    const app: FakeApp = { name: "TextEdit", pid: 10, windows: [window("Untitled")] };
    const core = makeCore([app]);
    const [old] = await core.list();
    app.windows = [window("Untitled", { bounds: { ...BOUNDS, x: 600 } })];
    expect(await core.call({ op: "key", window: old!.handle, keys: "enter" })).toMatchObject(
      staleNo,
    );
    expect(core.sent).toEqual([]);
    expect((await core.list())[0]!.handle).not.toBe(old!.handle);
  });
  it("refuses a reused AXIdentifier on a replacement window", async () => {
    const app: FakeApp = {
      name: "TextEdit",
      pid: 10,
      windows: [window("Before", { stableId: "MainWindow" })],
    };
    const core = makeCore([app]);
    const [old] = await core.list();
    app.windows = [window("After", { stableId: "MainWindow" })];
    expect(await core.call({ op: "key", window: old!.handle, keys: "enter" })).toMatchObject(
      staleNo,
    );
    expect(core.sent).toEqual([]);
  });
  it("refuses a replacement same-label control at the old path", async () => {
    const app: FakeApp = {
      name: "Mail",
      pid: 10,
      windows: [
        window("Inbox", {
          children: [
            { role: "button", name: "Open", bounds: { x: 10, y: 20, width: 50, height: 20 } },
          ],
        }),
      ],
    };
    const core = makeCore([app]);
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    app.windows[0]!.children = [
      { role: "button", name: "Open", bounds: { x: 300, y: 200, width: 50, height: 20 } },
    ];
    expect(
      await core.call({
        op: "press",
        element: ref!.handle,
        expect: { role: "button", label: "Open" },
      }),
    ).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });
});

describe("accessibility actions run in the background", () => {
  const field = { role: "text field", label: "Body" };
  /** A background TextEdit window while another app (99, e.g. ViewCode) is in front. */
  const background = (extra: Partial<Spec> = {}) => {
    const app: FakeApp = {
      name: "TextEdit",
      pid: 10,
      windows: [
        window("Notes", {
          active: false,
          focused: false,
          children: [{ role: "text field", name: "Body", ...extra }],
        }),
      ],
    };
    const phases: string[] = [];
    const options = {
      foreground: 99 as number | null,
      activate: (pid: number) => {
        options.foreground = pid;
        app.windows[0]!.active = true;
        app.windows[0]!.focused = true;
      },
      authorize: (_target: DriverDispatchTarget, phase: DriverDispatchPhase) =>
        void phases.push(phase),
    };
    return { app, options, phases, core: makeCore([app], options) };
  };

  const requests: Array<(element: string) => DriverRequest> = [
    (element) => ({ op: "press", element, expect: field }),
    (element) => ({ op: "setValue", element, expect: field, value: "v" }),
    (element) => ({ op: "typeText", element, expect: field, text: "t" }),
  ];

  for (const request of requests) {
    const op = request("e").op;
    it(`${op} acts without taking focus or needing the front`, async () => {
      const { app, options, phases, core } = background();
      const [win] = await core.list();
      const [ref] = await core.observe(win!.handle);
      expect(await core.call(request(ref!.handle))).toEqual(inBackground);
      expect(core.calls.activate).toBe(0);
      expect(options.foreground).toBe(99);
      expect(app.windows[0]!.active).toBe(false);
      expect(phases).toEqual(["prepare", "dispatch"]);
      expect(core.sent).toHaveLength(1);
    });
  }

  it("still refuses a background element that changed", async () => {
    const { app, core } = background();
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    app.windows[0]!.children = [{ role: "text field", name: "Password" }];
    expect(
      await core.call({ op: "typeText", element: ref!.handle, expect: field, text: "t" }),
    ).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  it("brings the window to the front only for the synthetic fallbacks", async () => {
    const press = background({
      pressUnsupported: true,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    const [pressWin] = await press.core.list();
    const [pressRef] = await press.core.observe(pressWin!.handle);
    expect(
      await press.core.call({ op: "press", element: pressRef!.handle, expect: field }),
    ).toEqual(focused);
    expect(press.core.calls.activate).toBe(1);
    expect(press.phases).toEqual(["prepare", "dispatch", "prepare", "dispatch"]);
    expect(press.core.sent).toEqual([["click", { x: 1, y: 2, width: 3, height: 4 }]]);

    const type = background({ typeUnsupported: true });
    const [typeWin] = await type.core.list();
    const [typeRef] = await type.core.observe(typeWin!.handle);
    expect(
      await type.core.call({ op: "typeText", element: typeRef!.handle, expect: field, text: "t" }),
    ).toEqual(focused);
    expect(type.core.calls.activate).toBe(1);
    expect(type.core.sent).toEqual([["typeText", "t"]]);
  });

  it("refuses a fallback whose window cannot be brought to the front", async () => {
    const { options, core } = background({ typeUnsupported: true });
    options.activate = () => undefined; // something keeps the front
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    expect(
      await core.call({ op: "typeText", element: ref!.handle, expect: field, text: "t" }),
    ).toMatchObject(refusedNo);
    expect(core.sent).toEqual([]);
  });
});

describe("activation budget", () => {
  /** A window whose app reaches the front once `delayMs` of injected sleep has passed. */
  const slowToActivate = (delayMs: number) => {
    const app: FakeApp = {
      name: "Notes",
      pid: 5,
      windows: [window("Note", { active: false, focused: false })],
    };
    let slept = 0;
    const options = {
      foreground: 99 as number | null,
      sleep: async (ms: number) => {
        slept += ms;
        if (slept >= delayMs) {
          options.foreground = 5;
          app.windows[0]!.active = true;
        }
      },
    };
    return { core: makeCore([app], options), slept: () => slept };
  };

  it("waits for a slow activation, such as `open -a` on a busy Mac", async () => {
    const { core, slept } = slowToActivate(2_000);
    const [note] = await core.list();
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toEqual(focused);
    expect(slept()).toBe(2_000);
    expect(core.sent).toEqual([["key", "Enter"]]);
  });

  it("still refuses once the budget is spent", async () => {
    const { core, slept } = slowToActivate(Number.POSITIVE_INFINITY);
    const [note] = await core.list();
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toEqual({
      ok: false,
      error: {
        kind: "failed",
        message: "Could not bring the target window to the front.",
        dispatched: "no",
      },
    });
    expect(slept()).toBe(ACTIVATION_TIMEOUT_MS);
    expect(core.sent).toEqual([]);
  });
});

it("refuses screenshots when the main display cannot be resolved", async () => {
  const app: FakeApp = {
    name: "TextEdit",
    pid: 10,
    windows: [window("Notes", { bounds: { ...BOUNDS, x: 9000 } })],
  };
  const core = makeCore([app], {
    primaryDisplay: () => null,
    capture: async () => ({ width: 2, height: 2, toPng: () => new Uint8Array([1]) }) as never,
  });
  const [win] = await core.list();
  expect(
    await core.call({
      op: "screenshot",
      window: win!.handle,
      outputPath: "/unused.png",
      maxSize: 256,
    }),
  ).toMatchObject(refusedNo);
});

describe("fallback input is authorized after its own preparation", () => {
  const policyChanges = [
    { change: "mode turned off", code: "CU-CON-002" },
    { change: "turn ended", code: "CU-CON-006" },
  ] as const;

  // The server's dispatch check, reduced to the two facts these tests change.
  const makePolicy = () => {
    const policy = { mode: "control", turn: "t1" };
    const authorize = (): ComputerUseError | undefined =>
      policy.mode !== "control"
        ? { code: "CU-CON-002", message: "off", effect: "not-dispatched" }
        : policy.turn !== "t1"
          ? { code: "CU-CON-006", message: "ended", effect: "not-dispatched" }
          : undefined;
    const apply = (change: (typeof policyChanges)[number]["change"]) => {
      if (change === "mode turned off") policy.mode = "off";
      else policy.turn = "t2";
    };
    return { authorize, apply };
  };

  /** A press whose accessible action is unsupported, so it falls back to a click. */
  const pressFallback = async () => {
    const policy = makePolicy();
    const preparing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const row: Spec = {
      role: "cell",
      name: "Row 3",
      pressUnsupported: true,
      bounds: { x: 10, y: 10, width: 50, height: 20 },
    };
    const app: FakeApp = { name: "Mail", pid: 7, windows: [window("Inbox", { children: [row] })] };
    const options: Parameters<typeof makeCore>[1] & { foreground: number | null } = {
      foreground: 7,
      // The fallback's own activation is where the policy can change.
      activate: async (pid) => {
        preparing.resolve();
        await resume.promise;
        options.foreground = pid;
      },
      authorize: policy.authorize,
    };
    // Something else takes the front as the accessible press fails.
    row.onPress = () => void (options.foreground = 99);
    const core = makeCore([app], options);
    const [inbox] = await core.list();
    const [cell] = await core.observe(inbox!.handle);
    const result = core.call({
      op: "press",
      element: cell!.handle,
      expect: { role: "cell", label: "Row 3" },
    });
    return { core, policy, preparing, resume, result };
  };

  /** Accessible text insertion unsupported, so it focuses the field and types. */
  const typeFallback = async () => {
    const policy = makePolicy();
    const preparing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const field: Spec = {
      role: "text field",
      name: "Body",
      typeUnsupported: true,
      onFocus: async () => {
        preparing.resolve();
        await resume.promise;
      },
    };
    const app: FakeApp = {
      name: "TextEdit",
      pid: 10,
      windows: [window("Notes", { children: [field] })],
    };
    const core = makeCore([app], { authorize: policy.authorize });
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    const result = core.call({
      op: "typeText",
      element: ref!.handle,
      expect: { role: "text field", label: "Body" },
      text: "secret",
    });
    return { core, policy, preparing, resume, result };
  };

  for (const { change, code } of policyChanges) {
    it(`press sends no click when the ${change} during fallback activation`, async () => {
      const { core, policy, preparing, resume, result } = await pressFallback();
      await preparing.promise;
      policy.apply(change);
      resume.resolve();
      expect(await result).toMatchObject({
        ok: false,
        error: { kind: "policy", code, dispatched: "no" },
      });
      expect(core.sent).toEqual([]);
    });

    it(`typeText types nothing when the ${change} during fallback focus`, async () => {
      const { core, policy, preparing, resume, result } = await typeFallback();
      await preparing.promise;
      policy.apply(change);
      resume.resolve();
      expect(await result).toMatchObject({
        ok: false,
        error: { kind: "policy", code, dispatched: "no" },
      });
      expect(core.sent).toEqual([]);
    });
  }

  it("still delivers both fallbacks while the policy holds", async () => {
    const press = await pressFallback();
    press.resume.resolve();
    expect(await press.result).toEqual(focused);
    expect(press.core.sent).toEqual([["click", { x: 10, y: 10, width: 50, height: 20 }]]);

    const type = await typeFallback();
    type.resume.resolve();
    expect(await type.result).toEqual(focused);
    expect(type.core.sent).toEqual([
      ["typeText", "s"],
      ["typeText", "e"],
      ["typeText", "c"],
      ["typeText", "r"],
      ["typeText", "e"],
      ["typeText", "t"],
    ]);
  });

  it.each(["typeFocused", "typeText"] as const)(
    "%s stops partial typing when a sibling window takes focus",
    async (op) => {
      const field: Spec = { role: "text field", name: "Body", typeUnsupported: true };
      const notes = window("Notes", { children: [field] });
      const sibling = window("Other", { active: false, focused: false });
      const app: FakeApp = { name: "TextEdit", pid: 10, windows: [notes, sibling] };
      // Each event takes longer than the focus re-check interval.
      const clock = { now: 0 };
      const core = makeCore([app], {
        clock,
        receiveText: () => {
          clock.now += 100;
          notes.active = notes.focused = false;
          sibling.active = sibling.focused = true;
        },
      });
      const [win] = await core.list();
      const [ref] = await core.observe(win!.handle);
      const result = await core.call(
        op === "typeFocused"
          ? { op, window: win!.handle, text: "secret" }
          : {
              op,
              element: ref!.handle,
              expect: { role: "text field", label: "Body" },
              text: "secret",
            },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "failed", dispatched: "unknown" },
      });
      expect(core.sent).toEqual([["typeText", "s"]]);
      expect(core.calls.activate).toBe(0);
      expect(sibling.active).toBe(true);
    },
  );
});

describe("a replacement element that matches every observed field", () => {
  const OPEN: Spec = {
    role: "button",
    name: "Open",
    stableId: "open",
    bounds: { x: 10, y: 20, width: 50, height: 20 },
  };

  it("is refused once the observed control is gone", async () => {
    const app: FakeApp = {
      name: "Mail",
      pid: 10,
      windows: [window("Inbox", { children: [{ ...OPEN }] })],
    };
    const core = makeCore([app]);
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    // Re-rendered: a new native object, identical in role, label, bounds, id and path.
    app.windows[0]!.children = [{ ...OPEN }];
    expect(
      await core.call({
        op: "press",
        element: ref!.handle,
        expect: { role: "button", label: "Open" },
      }),
    ).toMatchObject(staleNo);
    expect(core.sent).toEqual([]);
  });

  // Residual, documented in `resolveElement`: xa11y exposes no native
  // identity, so while the observed control is still alive elsewhere an
  // indistinguishable twin at its old path receives the action.
  it("cannot be told apart while the observed control is still alive", async () => {
    const original: Spec = { ...OPEN };
    const app: FakeApp = {
      name: "Mail",
      pid: 10,
      windows: [window("Inbox", { children: [original] })],
    };
    const core = makeCore([app]);
    const [win] = await core.list();
    const [ref] = await core.observe(win!.handle);
    const hits: string[] = [];
    const twin: Spec = { ...OPEN, onPress: () => void hits.push("twin") };
    original.onPress = () => void hits.push("original");
    app.windows[0]!.children = [twin, { role: "group", children: [original] }];
    expect(
      await core.call({
        op: "press",
        element: ref!.handle,
        expect: { role: "button", label: "Open" },
      }),
    ).toEqual(inBackground);
    expect(hits).toEqual(["twin"]);
  });
});

describe("nothing is prepared or sent once the policy refuses", () => {
  const field: Spec = {
    role: "text field",
    name: "Body",
    bounds: { x: 10, y: 10, width: 100, height: 20 },
  };
  const expect_ = { role: "text field", label: "Body" };
  const requests: Array<(window: string, element: string) => DriverRequest> = [
    (_window, element) => ({ op: "press", element, expect: expect_ }),
    (_window, element) => ({ op: "setValue", element, expect: expect_, value: "v" }),
    (_window, element) => ({ op: "typeText", element, expect: expect_, text: "t" }),
    (_window, element) => ({ op: "scroll", element, expect: expect_, dx: 0, dy: 1 }),
    (window) => ({ op: "key", window, keys: "enter" }),
    (window) => ({ op: "typeFocused", window, text: "t" }),
    (window) => ({
      op: "click",
      window,
      expectBounds: BOUNDS,
      point: { x: 5, y: 5 },
      button: "left",
      count: 1,
    }),
  ];

  for (const request of requests) {
    const op = request("w", "e").op;
    it(`${op} does not activate its window after the turn ended`, async () => {
      const app: FakeApp = {
        name: "Notes",
        pid: 5,
        windows: [window("Note", { active: false, focused: false, children: [{ ...field }] })],
      };
      const phases: string[] = [];
      const core = makeCore([app], {
        foreground: 99,
        authorize: (_target, phase) => {
          phases.push(phase);
          return { code: "CU-CON-006", message: "ended", effect: "not-dispatched" };
        },
      });
      const [note] = await core.list();
      const [ref] = await core.observe(note!.handle);
      expect(await core.call(request(note!.handle, ref!.handle))).toMatchObject({
        ok: false,
        error: { kind: "policy", code: "CU-CON-006", dispatched: "no" },
      });
      expect(phases).toEqual(["prepare"]);
      expect(core.calls.activate).toBe(0);
      expect(core.sent).toEqual([]);
    });
  }

  it("reports a failure before the input as not dispatched", async () => {
    let fail = false;
    const core = makeCore([{ name: "Notes", pid: 5, windows: [window("Note")] }], {
      executablePaths: async () => {
        if (fail) throw new Error("ps failed");
        return new Map();
      },
    });
    const [note] = await core.list();
    fail = true;
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toMatchObject({
      ok: false,
      error: { dispatched: "no" },
    });
    expect(core.sent).toEqual([]);
  });
});

it("reuses a display read briefly and re-reads it when it misses or ages", async () => {
  const clock = { now: 0 };
  let display = { x: 0, y: 0, width: 1000, height: 800 };
  const app: FakeApp = { name: "Notes", pid: 5, windows: [window("Note")] };
  const core = makeCore([app], {
    clock,
    primaryDisplay: () => display,
    capture: async () => ({ width: 2, height: 2, toPng: () => new Uint8Array([1]) }) as never,
  });
  const [note] = await core.list();
  const shoot = () =>
    core.call({ op: "screenshot", window: note!.handle, outputPath: "/unused.png", maxSize: 256 });
  expect(await shoot()).toMatchObject({ ok: true });
  expect(await shoot()).toMatchObject({ ok: true });
  expect(core.calls.primaryDisplay).toBe(1);
  // Off the cached display: read again before refusing.
  app.windows[0]!.bounds = { ...BOUNDS, x: 900 };
  display = { ...display, width: 2000 };
  expect(await shoot()).toMatchObject({ ok: true });
  expect(core.calls.primaryDisplay).toBe(2);
  clock.now = 5_000;
  expect(await shoot()).toMatchObject({ ok: true });
  expect(core.calls.primaryDisplay).toBe(3);
});
