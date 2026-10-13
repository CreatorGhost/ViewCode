import { describe, expect, it } from "vite-plus/test";

import { rememberedSpawnDisclosures, spawnedAgentsOpenKey } from "./SpawnedAgentRows.logic";

describe("rememberedSpawnDisclosures", () => {
  it("forgets opened agent groups so they are closed on the next visit", () => {
    const details = "agent-spawn:message-1";
    const remembered = rememberedSpawnDisclosures(
      new Set([spawnedAgentsOpenKey("row-1"), details, spawnedAgentsOpenKey("row-2")]),
    );
    expect([...remembered]).toEqual([details]);
  });

  it("returns the same set when no group is open", () => {
    const keys = new Set(["agent-spawn:message-1"]);
    expect(rememberedSpawnDisclosures(keys)).toBe(keys);
  });
});
