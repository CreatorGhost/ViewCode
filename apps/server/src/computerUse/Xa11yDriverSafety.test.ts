import type { App, Element, InputSim, Rect } from "@crowecawcaw/xa11y";
import { describe, expect, it } from "vite-plus/test";

import {
  appBundlePath,
  makeDriverCore,
  type DriverRequest,
  type DriverResult,
  type Xa11yApi,
} from "./Xa11yDriverCore.ts";

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
  children?: Spec[];
}

type Sent = Array<readonly [string, ...unknown[]]>;

const notSupported = () => Object.assign(new Error("x"), { name: "ActionNotSupportedError" });

const fake = (spec: Spec, sent: Sent): Element => {
  const snapshot = {
    role: spec.role,
    name: spec.name ?? null,
    description: spec.description ?? null,
    stableId: spec.stableId ?? null,
    bounds: spec.bounds ? { ...spec.bounds } : null,
    actions: spec.actions ?? ["press"],
  };
  return {
    ...snapshot,
    value: null,
    raw: {},
    editable: false,
    enabled: true,
    active: spec.active ?? false,
    focused: spec.focused ?? false,
    children: async () => (spec.children ?? []).map((child) => fake(child, sent)),
    tree: async () => ({ role: snapshot.role, name: snapshot.name ?? undefined, children: [] }),
    press: async () => {
      if (spec.pressUnsupported) throw notSupported();
      sent.push(["press", snapshot.name]);
    },
    setValue: async () => void sent.push(["setValue", snapshot.name]),
    performAction: async () => undefined,
    focus: async () => undefined,
  } as unknown as Element;
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
    readonly activate?: (pid: number) => void;
    readonly primaryDisplay?: () => Rect | null;
  } = {},
) => {
  const sent: Sent = [];
  const calls = { activate: 0, primaryDisplay: 0 };
  const input = {
    press: async (key: string) => void sent.push(["key", key]),
    chord: async (key: string, held: string[]) => void sent.push(["chord", key, held]),
    typeText: async (text: string) => void sent.push(["typeText", text]),
    click: async (target: unknown) =>
      void sent.push(["click", Array.isArray(target) ? target : (target as Element).bounds]),
    scroll: async (target: Element) => void sent.push(["scroll", target.bounds]),
    mouseUp: async (button: string) => void sent.push(["mouseUp", button]),
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
    foregroundPid: async () =>
      options.foreground === undefined ? (apps[0]?.pid ?? null) : options.foreground,
    inputSim: () => input,
    screenshot: async () => {
      throw new Error("no capture in these tests");
    },
    executablePaths: async () => new Map(),
    writeFile: async () => undefined,
    activateApp: async (pid) => {
      calls.activate += 1;
      options.activate?.(pid);
    },
    primaryDisplay: async () => {
      calls.primaryDisplay += 1;
      return options.primaryDisplay?.() ?? null;
    },
    sleep: async () => undefined,
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

  it("clicks the element where it is now when press is unsupported", async () => {
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
    ).toEqual(ok);
    expect(core.sent).toEqual([["click", { x: 10, y: 200, width: 50, height: 20 }]]);
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
    ).toEqual(ok);
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
    expect(await core.call({ op: "key", window: note!.handle, keys: "enter" })).toEqual(ok);
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

describe("screenshots and the mouse", () => {
  it("refuses windows that are not fully on the primary display, re-reading it once", async () => {
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
    expect(core.calls.primaryDisplay).toBe(2);
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
