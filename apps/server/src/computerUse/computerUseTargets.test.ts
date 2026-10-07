import { describe, expect, it } from "vite-plus/test";

import type { DriverElement, DriverWindow } from "./ComputerDriver.ts";
import { ThreadTargets } from "./computerUseTargets.ts";

const window: DriverWindow = { handle: "w1", app: "Notes", pid: 10, title: "Notes", focused: true };
const button: DriverElement = {
  handle: "e1",
  role: "button",
  label: "Save",
  enabled: true,
  focused: false,
};

describe("ThreadTargets", () => {
  it("treats numbers from an earlier server run as unknown", () => {
    const earlierRun = new ThreadTargets(100);
    const [listed] = earlierRun.recordWindows([window]);
    const [minted] = earlierRun.recordObservation(listed!.id, [button]);

    // The next run mints from a different base; the agent still quotes the old ref.
    const thisRun = new ThreadTargets(5_000);
    const [relisted] = thisRun.recordWindows([window]);
    thisRun.recordObservation(relisted!.id, [button]);

    expect(thisRun.lookupRef(minted!.ref)).toEqual({ _tag: "Unknown" });
    expect(thisRun.window(listed!.id)).toBeUndefined();
  });
});
