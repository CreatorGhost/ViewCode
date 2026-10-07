import { describe, expect, it } from "vite-plus/test";

import { forkThreadTitle } from "./forkThread.logic";

describe("forkThreadTitle", () => {
  it("prefixes once", () => {
    expect(forkThreadTitle("Fix bug")).toBe("Fork of Fix bug");
    expect(forkThreadTitle("Fork of Fork of Fix bug")).toBe("Fork of Fix bug");
    expect(forkThreadTitle(" ")).toBe("Fork of thread");
  });
});
