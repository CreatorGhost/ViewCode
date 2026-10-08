// @effect-diagnostics nodeBuiltinImport:off - exercises the plain Node helper protocol.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeMacMenuAccessibility } from "./MacMenuAccessibility.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const bar = {
  id: 1,
  role: "AXMenuBar",
  name: null,
  description: null,
  enabled: true,
  focused: false,
  actions: [],
};
const item = { ...bar, id: 2, role: "AXMenuBarItem", name: "File", actions: ["AXPress"] };
interface Request {
  readonly id: number;
  readonly op: string;
  readonly element?: number;
  readonly pid?: number;
}
const helper = (
  answer: (request: Request) => {
    readonly ok: boolean;
    readonly result?: unknown;
    readonly reason?: string;
  },
) => {
  const requests: Request[] = [];
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (data: Buffer) => {
    const request = JSON.parse(data.toString()) as Request;
    requests.push(request);
    queueMicrotask(() =>
      child.stdout.write(JSON.stringify({ id: request.id, ...answer(request) }) + "\n"),
    );
  });
  vi.mocked(NodeChildProcess.spawn).mockReturnValue(
    child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams,
  );
  return { requests, child };
};

describe("public AX menu adapter", () => {
  it("serializes concurrent app reads and retains the native identity for press and liveness", async () => {
    const { requests } = helper((r) => ({
      ok: true,
      result:
        r.op === "list" ? [bar] : r.op === "children" ? [item] : r.op === "alive" ? true : null,
    }));
    const menus = makeMacMenuAccessibility();
    try {
      const [[first], [second]] = await Promise.all([menus.list(7), menus.list(8)]);
      expect(first?.stableId).toBe(second?.stableId);
      expect(first?.role).toBe("menu_bar");
      const [file] = await first!.children();
      expect(file!.actions).toEqual(["press"]);
      expect(await menus.alive(file!)).toBe(true);
      await file!.press();
      expect(requests.map((r) => [r.op, r.pid ?? r.element])).toEqual([
        ["list", 7],
        ["list", 8],
        ["children", 1],
        ["alive", 2],
        ["press", 2],
      ]);
      expect(NodeChildProcess.spawn).toHaveBeenCalledTimes(1);
    } finally {
      menus.close();
    }
  });

  it("refuses a dead native ref without rebinding it to another item", async () => {
    const { requests } = helper((r) =>
      r.op === "list"
        ? { ok: true, result: [item] }
        : { ok: false, reason: "menu-element-unavailable" },
    );
    const menus = makeMacMenuAccessibility();
    try {
      const [file] = await menus.list(7);
      await expect(file!.press()).rejects.toMatchObject({ name: "ElementNotFoundError" });
      expect(requests.map((r) => r.op)).toEqual(["list", "press"]);
    } finally {
      menus.close();
    }
  });

  it("never reuses a menu ref after the helper restarts with recycled native IDs", async () => {
    const firstHelper = helper((r) => ({ ok: true, result: r.op === "list" ? [bar] : [item] }));
    const menus = makeMacMenuAccessibility();
    try {
      const [oldBar] = await menus.list(7);
      const [oldItem] = await oldBar!.children();
      firstHelper.child.emit("exit", 1);
      const replacement = helper(() => ({ ok: true, result: [bar] }));
      const [newBar] = await menus.list(7);
      expect(newBar!.stableId).not.toBe(oldBar!.stableId);
      expect(await menus.alive(oldItem!)).toBe(false);
      await expect(oldItem!.press()).rejects.toMatchObject({ name: "ElementNotFoundError" });
      await expect(oldBar!.children()).rejects.toMatchObject({ name: "ElementNotFoundError" });
      expect(replacement.requests.map((r) => r.op)).toEqual(["list"]);
    } finally {
      menus.close();
    }
  });

  it("rejects malformed menu snapshots", async () => {
    helper(() => ({ ok: true, result: [{ ...bar, id: "1" }] }));
    const menus = makeMacMenuAccessibility();
    try {
      await expect(menus.list(7)).rejects.toThrow("Invalid menu helper reply");
    } finally {
      menus.close();
    }
  });
});
