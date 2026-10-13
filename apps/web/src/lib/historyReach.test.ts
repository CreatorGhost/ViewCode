import { describe, expect, it } from "vite-plus/test";

import { nextHistoryReach } from "./historyReach";

describe("nextHistoryReach", () => {
  it("keeps the entries ahead while moving back and forward", () => {
    let reach = 0;
    reach = nextHistoryReach(reach, "PUSH", 1);
    reach = nextHistoryReach(reach, "PUSH", 2);
    reach = nextHistoryReach(reach, "BACK", 1);
    expect(reach).toBe(2);
    reach = nextHistoryReach(reach, "GO", 0);
    expect(reach).toBe(2);
    reach = nextHistoryReach(reach, "FORWARD", 1);
    expect(reach).toBe(2);
  });

  it("drops the entries ahead when a new page opens", () => {
    let reach = nextHistoryReach(0, "PUSH", 3);
    reach = nextHistoryReach(reach, "BACK", 1);
    reach = nextHistoryReach(reach, "PUSH", 2);
    expect(reach).toBe(2);
  });

  it("leaves the reach alone when a page replaces itself", () => {
    expect(nextHistoryReach(4, "REPLACE", 2)).toBe(4);
  });
});
