// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - owned by the plain Node driver worker.
/** Public AXMenuBar access for apps whose xa11y children omit it. */
import * as NodeChildProcess from "node:child_process";
import type { Element } from "@crowecawcaw/xa11y";

const SCRIPT = `ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("ApplicationServices");
ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["id", "id", "id*"]]);
ObjC.bindFunction("AXUIElementCopyActionNames", ["int", ["id", "id*"]]);
ObjC.bindFunction("AXUIElementPerformAction", ["int", ["id", "id"]]);
var retained = {}, next = 0;
function attr(e, name) { var out = Ref(); return $.AXUIElementCopyAttributeValue(e, $(name), out) === 0 ? out[0] : null; }
function text(e, name) { var v = attr(e, name); return v ? ObjC.unwrap(v) : null; }
function retain(e) {
  for (var id in retained) if ($.CFEqual(retained[id], e)) return Number(id);
  if (Object.keys(retained).length >= 4096) throw Error("menu-reference-limit");
  var id = ++next; retained[id] = e; return id;
}
function node(e) {
  var role = text(e, "AXRole"); if (!role) throw Error("menu-element-unavailable");
  var actions = Ref(); var names = $.AXUIElementCopyActionNames(e, actions) === 0 ? ObjC.deepUnwrap(actions[0]) : [];
  return { id: retain(e), role: role, name: text(e, "AXTitle"), description: text(e, "AXDescription"), enabled: !!ObjC.unwrap(attr(e, "AXEnabled")), focused: !!ObjC.unwrap(attr(e, "AXFocused")), actions: names || [] };
}
function execute(r) {
  if (r.op === "list") {
    var app = ObjC.castRefToObject($.AXUIElementCreateApplication(r.pid)), bar = attr(app, "AXMenuBar");
    return bar ? [node(bar)] : [];
  }
  var e = retained[r.element]; if (!e) throw Error("menu-element-unavailable");
  if (r.op === "alive") return !!attr(e, "AXParent") && !!attr(e, "AXRole");
  if (r.op === "children") {
    var children = attr(e, "AXChildren"), out = [];
    if (children) for (var i = 0; i < Math.min(Number(children.count), 512); i++) out.push(node(children.objectAtIndex(i)));
    if (children && Number(children.count) > 512) throw Error("menu-children-limit");
    return out;
  }
  if (r.op === "press") {
    if (!attr(e, "AXParent") || !attr(e, "AXRole")) throw Error("menu-element-unavailable");
    var error = $.AXUIElementPerformAction(e, $("AXPress"));
    if (error !== 0) throw Error(error === -25206 ? "menu-action-unsupported" : "menu-action-failed");
    return null;
  }
  throw Error("unsupported-menu-operation");
}
function output(value) { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(value) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
function run() {
  var pending = "";
  while (true) {
    var data = $.NSFileHandle.fileHandleWithStandardInput.availableData;
    if (Number(data.length) === 0) break;
    pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var lines = pending.split("\\n"); pending = lines.pop();
    lines.forEach(function(line) { var r; try { r = JSON.parse(line); output({ id: r.id, ok: true, result: execute(r) }); } catch(e) { output({ id: r && r.id, ok: false, reason: String(e) }); } });
  }
}`;

interface MenuNode {
  readonly id: number;
  readonly role: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly actions: ReadonlyArray<string>;
}
const isNode = (value: unknown): value is MenuNode =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "number" &&
  Number.isInteger(value.id) &&
  value.id > 0 &&
  "role" in value &&
  typeof value.role === "string" &&
  "name" in value &&
  (value.name === null || typeof value.name === "string") &&
  "description" in value &&
  (value.description === null || typeof value.description === "string") &&
  "enabled" in value &&
  typeof value.enabled === "boolean" &&
  "focused" in value &&
  typeof value.focused === "boolean" &&
  "actions" in value &&
  Array.isArray(value.actions) &&
  value.actions.every((name: unknown) => typeof name === "string");
const parseNodes = (value: unknown): ReadonlyArray<MenuNode> => {
  if (!Array.isArray(value) || !value.every(isNode)) throw Error("Invalid menu helper reply.");
  return value;
};
const failure = (reason: string) =>
  Object.assign(new Error("The menu control is unavailable. Observe again."), {
    name: reason.includes("menu-action-unsupported")
      ? "ActionNotSupportedError"
      : "ElementNotFoundError",
  });
type Request =
  | { readonly op: "list"; readonly pid: number }
  | { readonly op: "children" | "alive" | "press"; readonly element: number };

/** One serialized helper; retained AXUIElements keep stale refs from binding to replacements. */
export const makeMacMenuAccessibility = () => {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let next = 0;
  let generation = 0;
  let buffered = "";
  let queue = Promise.resolve();
  let pending:
    | { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  const close = () => {
    const owned = child;
    child = undefined;
    owned?.stdin.end();
    owned?.kill();
    pending?.reject(failure("helper-closed"));
    pending = undefined;
    buffered = "";
  };
  const call = (request: Request, expectedGeneration?: number): Promise<unknown> => {
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        if (expectedGeneration !== undefined && (!child || expectedGeneration !== generation)) {
          reject(failure("menu-helper-restarted"));
          return;
        }
        if (!child) generation++;
        child ??= NodeChildProcess.spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const owned = child;
        if (owned.stdout.listenerCount("data") === 0) {
          owned.stdout.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              let reply: unknown;
              try {
                reply = JSON.parse(line);
              } catch {
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
              if ("ok" in reply && reply.ok === true && "result" in reply)
                pending?.resolve(reply.result);
              else
                pending?.reject(
                  failure("reason" in reply ? String(reply.reason) : "invalid-reply"),
                );
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
        const id = ++next;
        const timer = setTimeout(() => {
          reject(failure("helper-timeout"));
          close();
        }, 5000);
        pending = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            pending = undefined;
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending = undefined;
            reject(error);
          },
        };
        owned.stdin.write(JSON.stringify({ id, ...request }) + "\n", (error) => {
          if (error) close();
        });
      });
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const element = (node: MenuNode): Element => {
    const ownGeneration = generation;
    const unsupported = async () => {
      throw Object.assign(new Error("Menu controls require press by ref."), {
        name: "ActionNotSupportedError",
      });
    };
    // xa11y's native class cannot represent an AXMenuBar obtained by attribute.
    // This adapter implements the Element operations used by DriverCore. It must
    // never be passed to xa11y's native screenshot or inputSim methods.
    const adapted = {
      role: node.role === "AXMenuBar" ? "menu_bar" : node.role === "AXMenu" ? "menu" : "menu_item",
      name: node.name,
      description: node.description,
      stableId: "public-ax-menu:" + ownGeneration + ":" + node.id,
      value: null,
      bounds: null,
      active: false,
      focused: node.focused,
      enabled: node.enabled,
      editable: false,
      raw: { ax_role: node.role },
      actions: node.actions.map((action) => (action === "AXPress" ? "press" : action)),
      children: async () =>
        parseNodes(await call({ op: "children", element: node.id }, ownGeneration)).map(element),
      press: async () => {
        await call({ op: "press", element: node.id }, ownGeneration);
      },
      focus: unsupported,
      performAction: unsupported,
      setValue: unsupported,
      typeText: unsupported,
    };
    const result = adapted as unknown as Element;
    nodes.set(result, { id: node.id, generation: ownGeneration });
    return result;
  };
  const nodes = new WeakMap<Element, { readonly id: number; readonly generation: number }>();
  return {
    close,
    list: async (pid: number) => parseNodes(await call({ op: "list", pid })).map(element),
    owns: (target: Element) => nodes.has(target),
    alive: async (target: Element) => {
      const node = nodes.get(target);
      return (
        node !== undefined &&
        !!child &&
        node.generation === generation &&
        (await call({ op: "alive", element: node.id }, node.generation)) === true
      );
    },
  };
};
