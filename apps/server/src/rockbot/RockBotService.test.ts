import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { latestModelSource, refusedRockBotKindChange } from "./RockBotService.ts";

const shell = (id: string, updatedAt: string, extra: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id,
    updatedAt: DateTime.makeUnsafe(updatedAt),
    deletedAt: null,
    kind: null,
    ...extra,
  }) as unknown as OrchestrationV2ThreadShell;

describe("latestModelSource", () => {
  it("starts RockBot on the model of the thread the user touched last, never its own", () => {
    expect(
      latestModelSource([
        shell("old", "2026-10-19T10:00:00Z"),
        shell("rockbot", "2026-10-20T12:00:00Z", { kind: "orchestrator" }),
        shell("recent", "2026-10-20T09:00:00Z"),
      ])?.id,
    ).toBe("recent");
  });

  it("has nothing to borrow before the first thread", () => {
    expect(latestModelSource([])).toBeNull();
  });
});

describe("refusedRockBotKindChange", () => {
  it("lets clients create and change ordinary threads and side chats", () => {
    expect(refusedRockBotKindChange({ type: "thread.create" }, undefined)).toBeNull();
    expect(refusedRockBotKindChange({ type: "thread.fork", kind: "sidechat" }, null)).toBeNull();
    expect(
      refusedRockBotKindChange({ type: "thread.metadata.update", kind: null }, "sidechat"),
    ).toBeNull();
    expect(refusedRockBotKindChange({ type: "thread.metadata.update" }, "orchestrator")).toBeNull();
  });

  it("refuses making a thread RockBot or turning RockBot back into an ordinary thread", () => {
    expect(
      refusedRockBotKindChange({ type: "thread.create", kind: "orchestrator" }, undefined),
    ).not.toBeNull();
    expect(
      refusedRockBotKindChange({ type: "thread.metadata.update", kind: "orchestrator" }, null),
    ).not.toBeNull();
    expect(
      refusedRockBotKindChange({ type: "thread.metadata.update", kind: null }, "orchestrator"),
    ).not.toBeNull();
  });
});
