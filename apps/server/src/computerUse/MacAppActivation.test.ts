// @effect-diagnostics nodeBuiltinImport:off - checks the public AppKit activation script.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { activateMacApp, MAC_APP_ACTIVATION_SCRIPT } from "./MacAppActivation.ts";

const run = (
  pid: number,
  apps: ReadonlyMap<number, { activateWithOptions: (options: number) => boolean }>,
) =>
  NodeVM.runInNewContext(MAC_APP_ACTIVATION_SCRIPT + `; run([${JSON.stringify(String(pid))}]);`, {
    ObjC: { import: () => undefined },
    $: {
      NSApplication: { sharedApplication: { setActivationPolicy: () => undefined } },
      NSApplicationActivationPolicyProhibited: 2,
      NSApplicationActivateIgnoringOtherApps: 1,
      NSRunningApplication: {
        runningApplicationWithProcessIdentifier: (value: number) => apps.get(value),
      },
    },
  });

describe("exact macOS application activation", () => {
  it("selects only the requested process when two instances share a bundle", () => {
    const activated: number[] = [];
    const apps = new Map(
      [41, 42].map((pid) => [
        pid,
        {
          bundle: "same.bundle",
          activateWithOptions: () => {
            activated.push(pid);
            return true;
          },
        },
      ]),
    );
    run(42, apps);
    expect(activated).toEqual([42]);
  });

  it("refuses a missing or unactivatable process without choosing another instance", () => {
    const apps = new Map([[41, { activateWithOptions: () => false }]]);
    expect(() => run(42, apps)).toThrow("unavailable");
    expect(() => run(41, apps)).toThrow("refused activation");
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid PID %s before launching", async (pid) => {
    await expect(activateMacApp(pid)).rejects.toThrow("Invalid application PID");
  });
});
