import { describe, expect, it } from "vite-plus/test";

import { turnStateAfterCheckpoint } from "./turnSettlement.ts";

describe("turnStateAfterCheckpoint", () => {
  it.each(["ready", "missing", "error"] as const)(
    "never turns a failed turn into completed (checkpoint %s)",
    (checkpointStatus) => {
      expect(turnStateAfterCheckpoint("error", checkpointStatus)).toBe("error");
    },
  );

  it.each(["ready", "missing", "error"] as const)(
    "keeps an interrupted turn interrupted (checkpoint %s)",
    (checkpointStatus) => {
      expect(turnStateAfterCheckpoint("interrupted", checkpointStatus)).toBe("interrupted");
    },
  );

  it.each([null, undefined, "pending", "running", "completed"] as const)(
    "settles a %s turn from the checkpoint",
    (existing) => {
      expect(turnStateAfterCheckpoint(existing, "ready")).toBe("completed");
      expect(turnStateAfterCheckpoint(existing, "missing")).toBe("completed");
      expect(turnStateAfterCheckpoint(existing, "error")).toBe("error");
    },
  );
});
