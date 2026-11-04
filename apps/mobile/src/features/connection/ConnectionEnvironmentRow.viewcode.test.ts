// @effect-diagnostics nodeBuiltinImport:off - a read of this app's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// On Android a switch inside a Pressable loses the tap: once the Pressable is the JS responder its
// native view intercepts the move events and the Compose switch gets ACTION_CANCEL. The switches
// sit beside their row's Pressable instead.
describe("Android switches toggle on the first tap (ViewCode)", () => {
  it("keeps the environment switch outside the row's Pressable", () => {
    const row = read("ConnectionEnvironmentRow.tsx");
    const switchAt = row.indexOf("<ThemedSwitch");
    expect(switchAt).toBeGreaterThan(-1);
    const before = row.slice(0, switchAt);
    const opened = before.split("<Pressable").length - 1;
    const closed = before.split("</Pressable>").length - 1;
    expect(opened).toBe(closed);
  });

  it("passes the private repository switch as a control beside the row", () => {
    const addProject = read("../projects/AddProjectScreen.tsx");
    expect(addProject).toMatch(
      /control=\{\s*<ThemedSwitch\s+accessibilityLabel="Create private repository on GitHub"/,
    );
    expect(addProject).toContain('<View className="pr-4">{props.control}</View>');
  });
});
