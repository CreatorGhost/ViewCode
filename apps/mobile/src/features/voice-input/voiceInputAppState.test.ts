import { describe, expect, it } from "vite-plus/test";

import { voiceInputStopsForAppState } from "./voiceInputAppState";

describe("voiceInputStopsForAppState", () => {
  it("keeps Android preparing through the permission dialog's pause", () => {
    expect(voiceInputStopsForAppState("android", "background", "preparing")).toBe(false);
  });

  it("still stops a recording, and iOS preparation, when the app leaves", () => {
    expect(voiceInputStopsForAppState("android", "background", "recording")).toBe(true);
    expect(voiceInputStopsForAppState("ios", "background", "preparing")).toBe(true);
    expect(voiceInputStopsForAppState("ios", "inactive", "preparing")).toBe(false);
  });
});
