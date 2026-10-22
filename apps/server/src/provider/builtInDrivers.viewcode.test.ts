import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS, BUILT_IN_USAGE_DRIVERS } from "./builtInDrivers.ts";
import { DevinDriver, DroidDriver } from "./viewcode/acpDrivers.ts";
import { CommandCodeDriver } from "./viewcode/commandCodeDriver.ts";
import { ViewCodeCursorDriver } from "./viewcode/cursorDriver.ts";

// ViewCode's own providers reach the server only through this upstream list. A merge that
// takes upstream's copy drops them with no error: the providers just vanish from Settings.
describe("built-in provider drivers (ViewCode)", () => {
  it.each([
    ["Command Code", CommandCodeDriver],
    ["Droid", DroidDriver],
    ["Devin", DevinDriver],
  ] as const)("registers %s", (_name, driver) => {
    expect(BUILT_IN_DRIVERS).toContain(driver);
  });

  // The wrapper adds the cursor-agent CLI runtime beside upstream's SDK runtime.
  it("registers Cursor through ViewCode's wrapper, for drivers and usage alike", () => {
    expect(BUILT_IN_DRIVERS).toContain(ViewCodeCursorDriver);
    expect(BUILT_IN_USAGE_DRIVERS).toContain(ViewCodeCursorDriver);
  });
});
