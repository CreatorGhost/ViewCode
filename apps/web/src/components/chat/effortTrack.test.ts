import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  edgeFade,
  effortBrandForDriver,
  effortRandom,
  effortTrackFrameRate,
  effortTrackKind,
  effortTrackStyle,
  flashAt,
} from "./effortTrack";

describe("effortTrackKind", () => {
  it("has four distinct looks", () => {
    expect(effortTrackKind({ peak: false, fast: false })).toBe("plain");
    expect(effortTrackKind({ peak: false, fast: true })).toBe("fast");
    expect(effortTrackKind({ peak: true, fast: false })).toBe("supercharged");
    expect(effortTrackKind({ peak: true, fast: true })).toBe("fusion");
  });

  it("draws sparks alone at 30fps and anything with streaks at 60", () => {
    expect(effortTrackFrameRate("supercharged")).toBe(30);
    expect(effortTrackFrameRate("fast")).toBe(60);
    expect(effortTrackFrameRate("fusion")).toBe(60);
  });
});

describe("effortBrandForDriver", () => {
  it("maps providers to their brand, black-and-white marks to silver", () => {
    expect(effortBrandForDriver(ProviderDriverKind.make("claudeAgent"))).toBe("claude");
    expect(effortBrandForDriver(ProviderDriverKind.make("antigravity"))).toBe("antigravity");
    for (const driver of ["codex", "cursor", "grok", "opencode", "commandCode"]) {
      expect(effortBrandForDriver(ProviderDriverKind.make(driver))).toBe("silver");
    }
    expect(effortBrandForDriver(null)).toBe("purple");
  });

  it("reads dark on silver's white fill at max, and light again in fusion", () => {
    const max = effortTrackStyle("supercharged", "silver");
    expect(max.stopPassed).toBe("rgb(0 0 0 / 0.35)");
    expect(max.knobEdge).toBe("rgb(0 0 0 / 0.14)");
    expect(max.titleColor).toBe("var(--foreground)");
    const fusion = effortTrackStyle("fusion", "silver");
    expect(fusion.stopPassed).toBe("rgb(255 255 255 / 0.6)");
    expect(fusion.knobEdge).toBe("transparent");
    expect(fusion.titleGradient).not.toBeNull();
  });

  it("gives Claude its terracotta at max and gold in fast mode", () => {
    expect(effortTrackStyle("supercharged", "claude").fillBackground).toBe("rgb(204 107 71)");
    expect(effortTrackStyle("fast", "claude").fillBackground).toBe("rgb(237 168 33)");
  });
});

describe("effect maths", () => {
  it("is deterministic per element and trait, and stays in [0, 1)", () => {
    expect(effortRandom(3, 2)).toBe(effortRandom(3, 2));
    expect(effortRandom(3, 2)).not.toBe(effortRandom(3, 3));
    for (let index = 0; index < 200; index += 1) {
      const value = effortRandom(index, index % 7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("fades out over 14px at either end of the fill", () => {
    expect(edgeFade(0, 100)).toBe(0);
    expect(edgeFade(7, 100)).toBe(0.5);
    expect(edgeFade(50, 100)).toBe(1);
    expect(edgeFade(93, 100)).toBe(0.5);
    expect(edgeFade(120, 100)).toBe(0);
  });

  it("flashes briefly once per beat and is dark between", () => {
    const beat = { seed: 200, basePeriod: 1.4, periodSpread: 0.9, flash: 0.26 };
    let lit = 0;
    for (let tick = 0; tick < 1000; tick += 1) {
      if (flashAt({ ...beat, time: tick / 100 }).intensity > 0) lit += 1;
    }
    // About a quarter second lit per 1.4–2.3s beat.
    expect(lit / 1000).toBeGreaterThan(0.08);
    expect(lit / 1000).toBeLessThan(0.2);
    expect(flashAt({ ...beat, time: 3 })).toEqual(flashAt({ ...beat, time: 3 }));
  });
});
