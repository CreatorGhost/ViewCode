import { assert, describe, it } from "@effect/vitest";

import { computerDriverBinary, computerDriverBinaryCandidates } from "./NativeComputerDriver.ts";

describe("NativeComputerDriver", () => {
  it("looks beside the app's resource monitor first, then beside the server, then in a checkout", () => {
    const candidates = computerDriverBinaryCandidates({
      platform: "darwin",
      override: "",
      resourceMonitorPath: "/App/Contents/Resources/resource-monitor/t3-resource-monitor",
      moduleDir: "/repo/apps/server/src/computerUse",
    });
    assert.strictEqual(
      candidates[0],
      "/App/Contents/Resources/computer-driver/viewcode-computer-driver",
    );
    assert.include(
      candidates,
      "/repo/native/computer-driver/target/release/viewcode-computer-driver",
    );
    // From a built server (`apps/server/dist` or `dist-exe`) the checkout is one level closer.
    assert.include(
      computerDriverBinaryCandidates({
        platform: "darwin",
        override: "",
        resourceMonitorPath: undefined,
        moduleDir: "/repo/apps/server/dist",
      }),
      "/repo/native/computer-driver/target/release/viewcode-computer-driver",
    );
  });

  it("a given path is the only place looked at", () => {
    assert.deepStrictEqual(
      computerDriverBinaryCandidates({
        platform: "darwin",
        override: " /opt/helper ",
        resourceMonitorPath: "/App/Contents/Resources/resource-monitor/t3-resource-monitor",
        moduleDir: "/repo/apps/server/dist",
      }),
      ["/opt/helper"],
    );
  });

  it("starts the first helper that exists, else the first place it looked", () => {
    assert.strictEqual(
      computerDriverBinary(["/a", "/b", "/c"], (path) => path !== "/a"),
      "/b",
    );
    assert.strictEqual(
      computerDriverBinary(["/a", "/b"], () => false),
      "/a",
    );
  });
});
