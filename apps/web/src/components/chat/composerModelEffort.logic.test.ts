import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEffortStops,
  effortFractionAtPointer,
  effortRampForIndex,
  effortStopForKey,
  effortStopFraction,
  effortTierForIndex,
  findEffortDescriptor,
  isEffortAndFastModeAtDefaults,
  modelSupportsFastMode,
  nearestEffortStop,
  offersUltracode,
  resetEffortAndFastMode,
  resolveEffortStopIndex,
  resolveFastModeControl,
} from "./composerModelEffort.logic";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

const EFFORT = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
  ],
} satisfies ProviderOptionDescriptor;

const CONTEXT_WINDOW = {
  id: "contextWindow",
  label: "Context Window",
  type: "select",
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M", isDefault: true },
  ],
} satisfies ProviderOptionDescriptor;

function fastMode(currentValue?: boolean): ProviderOptionDescriptor {
  return {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    ...(currentValue === undefined ? {} : { currentValue }),
  };
}

function serviceTier(currentValue: string): ProviderOptionDescriptor {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

describe("findEffortDescriptor", () => {
  it("finds the effort select whatever the provider calls it", () => {
    expect(findEffortDescriptor([CONTEXT_WINDOW, EFFORT])?.id).toBe("effort");
    expect(findEffortDescriptor([{ ...EFFORT, id: "variant" }])?.id).toBe("variant");
    expect(findEffortDescriptor([{ ...EFFORT, id: "reasoningEffort" }])?.id).toBe(
      "reasoningEffort",
    );
  });

  it("ignores unrelated selects so a context window never becomes the slider", () => {
    expect(findEffortDescriptor([CONTEXT_WINDOW, fastMode(false)])).toBeNull();
  });
});

const CLAUDE_EFFORT = {
  ...EFFORT,
  options: [
    ...EFFORT.options,
    { id: "ultracode", label: "Ultracode" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
} satisfies ProviderOptionDescriptor;

describe("buildEffortStops", () => {
  it("ends the slider at Max: Ultracode is a switch and Ultrathink is typed", () => {
    expect(buildEffortStops(CLAUDE_EFFORT).map(({ id }) => id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(offersUltracode(CLAUDE_EFFORT)).toBe(true);
    expect(offersUltracode(EFFORT)).toBe(false);
  });
});

describe("resolveEffortStopIndex", () => {
  const stops = buildEffortStops(CLAUDE_EFFORT);

  it("locates the current value among the stops", () => {
    expect(resolveEffortStopIndex(CLAUDE_EFFORT, stops, "xhigh")).toBe(3);
  });

  it("shows Ultracode at Extra High, the level the server runs it at", () => {
    expect(resolveEffortStopIndex(CLAUDE_EFFORT, stops, "ultracode")).toBe(3);
  });

  it("falls back to the default stop for an unknown, missing or off-slider value", () => {
    expect(resolveEffortStopIndex(CLAUDE_EFFORT, stops, "brutal")).toBe(1);
    expect(resolveEffortStopIndex(CLAUDE_EFFORT, stops, null)).toBe(1);
    expect(resolveEffortStopIndex(CLAUDE_EFFORT, stops, "ultrathink")).toBe(1);
  });

  it("falls back to the first stop when nothing is marked default", () => {
    const noDefault = {
      ...EFFORT,
      options: EFFORT.options.map(({ id, label }) => ({ id, label })),
    };
    expect(resolveEffortStopIndex(noDefault, buildEffortStops(noDefault), null)).toBe(0);
  });

  it("has no stop without a descriptor", () => {
    expect(resolveEffortStopIndex(null, [], "high")).toBe(-1);
    expect(buildEffortStops(null)).toEqual([]);
  });
});

describe("slider geometry", () => {
  it("places stops evenly along the knob's travel", () => {
    expect([0, 1, 2, 3, 4].map((index) => effortStopFraction(index, 5))).toEqual([
      0, 0.25, 0.5, 0.75, 1,
    ]);
    expect(effortStopFraction(3, 1)).toBe(0);
  });

  it("maps a pointer to the travel, clamping past the insets", () => {
    const track = { trackLeft: 100, trackWidth: 334, inset: 17 };
    expect(effortFractionAtPointer({ ...track, clientX: 117 })).toBe(0);
    expect(effortFractionAtPointer({ ...track, clientX: 267 })).toBe(0.5);
    expect(effortFractionAtPointer({ ...track, clientX: 90 })).toBe(0);
    expect(effortFractionAtPointer({ ...track, clientX: 999 })).toBe(1);
  });

  it("commits the nearest stop, switching halfway between two", () => {
    expect(nearestEffortStop(0.12, 5)).toBe(0);
    expect(nearestEffortStop(0.13, 5)).toBe(1);
    expect(nearestEffortStop(1, 5)).toBe(4);
    expect(nearestEffortStop(0.7, 1)).toBe(0);
  });

  it("moves one stop per arrow and jumps with Home and End", () => {
    expect(effortStopForKey("ArrowRight", 2, 5)).toBe(3);
    expect(effortStopForKey("ArrowRight", 4, 5)).toBe(4);
    expect(effortStopForKey("ArrowLeft", 0, 5)).toBe(0);
    expect(effortStopForKey("Home", 3, 5)).toBe(0);
    expect(effortStopForKey("End", 1, 5)).toBe(4);
    expect(effortStopForKey("a", 1, 5)).toBeNull();
  });
});

describe("effortTierForIndex", () => {
  it("makes Max and every stop above it the peak", () => {
    const stops = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"].map(
      (id) => ({ id }),
    );
    expect(stops.map((_, index) => effortTierForIndex(index, stops))).toEqual([
      "standard",
      "standard",
      "standard",
      "standard",
      "peak",
      "peak",
      "peak",
    ]);
  });

  it("falls back to the highest stop without a Max, and never marks a lone stop", () => {
    // Grok's top level is Extra High.
    const stops = ["low", "medium", "high", "xhigh"].map((id) => ({ id }));
    expect(effortTierForIndex(3, stops)).toBe("peak");
    expect(effortTierForIndex(2, stops)).toBe("standard");
    expect(effortTierForIndex(0, stops)).toBe("standard");
    expect(effortTierForIndex(0, [{ id: "max" }])).toBe("standard");
  });
});

describe("resolveFastModeControl", () => {
  it("reads the fastMode boolean", () => {
    expect(resolveFastModeControl(CLAUDE, [EFFORT, fastMode(true)])).toEqual({
      descriptorId: "fastMode",
      enabled: true,
      onValue: true,
      offValue: false,
    });
    expect(resolveFastModeControl(CLAUDE, [EFFORT, fastMode()])?.enabled).toBe(false);
  });

  it("maps Codex's Standard/Fast service tier onto an on/off switch", () => {
    expect(resolveFastModeControl(CODEX, [EFFORT, serviceTier("priority")])).toEqual({
      descriptorId: "serviceTier",
      enabled: true,
      onValue: "priority",
      offValue: "default",
    });
    expect(resolveFastModeControl(CODEX, [serviceTier("default")])?.enabled).toBe(false);
  });

  it("leaves a Flex service tier as an ordinary option", () => {
    expect(resolveFastModeControl(CODEX, [serviceTier("flex")])).toBeNull();
  });

  it("has no control when the model offers no fast mode", () => {
    expect(resolveFastModeControl(CLAUDE, [EFFORT, CONTEXT_WINDOW])).toBeNull();
    expect(resolveFastModeControl(CLAUDE, [serviceTier("priority")])).toBeNull();
  });
});

describe("modelSupportsFastMode", () => {
  it("detects either fast-mode shape in catalog capabilities", () => {
    expect(modelSupportsFastMode(CLAUDE, { optionDescriptors: [EFFORT, fastMode()] })).toBe(true);
    expect(
      modelSupportsFastMode(CODEX, { optionDescriptors: [EFFORT, serviceTier("default")] }),
    ).toBe(true);
    expect(modelSupportsFastMode(CLAUDE, { optionDescriptors: [EFFORT] })).toBe(false);
    expect(modelSupportsFastMode(CLAUDE, undefined)).toBe(false);
  });
});

describe("resetEffortAndFastMode", () => {
  const defaults = [EFFORT, fastMode(false), CONTEXT_WINDOW];

  it("restores effort and fast mode but keeps the other options", () => {
    const current = [
      { ...EFFORT, currentValue: "max" },
      fastMode(true),
      { ...CONTEXT_WINDOW, currentValue: "200k" },
    ];
    const reset = resetEffortAndFastMode({
      current,
      defaults,
      descriptorIds: ["effort", "fastMode"],
    });
    expect(reset).toEqual([
      { ...EFFORT, currentValue: "medium" },
      fastMode(false),
      { ...CONTEXT_WINDOW, currentValue: "200k" },
    ]);
    expect(isEffortAndFastModeAtDefaults({ current, defaults, descriptorIds: ["effort"] })).toBe(
      false,
    );
    expect(
      isEffortAndFastModeAtDefaults({
        current: reset,
        defaults,
        descriptorIds: ["effort", "fastMode"],
      }),
    ).toBe(true);
  });

  it("treats an unset fast mode as off", () => {
    expect(
      isEffortAndFastModeAtDefaults({
        current: [fastMode()],
        defaults: [fastMode(false)],
        descriptorIds: ["fastMode"],
      }),
    ).toBe(true);
  });
});

describe("effortRampForIndex", () => {
  it("runs from 0 at the lowest stop to 1 just below Max, and stays 1 at the peak", () => {
    const stops = ["low", "medium", "high", "xhigh", "max", "ultrathink"].map((id) => ({ id }));
    expect(stops.map((_, index) => effortRampForIndex(index, stops))).toEqual([
      0,
      1 / 3,
      2 / 3,
      1,
      1,
      1,
    ]);
  });
});
