import { describe, expect, it } from "@effect/vitest";

import { selectedEffort, withoutEffort } from "./modelOptions.ts";

describe("selectedEffort", () => {
  it("reads the effort under whichever descriptor id the provider uses", () => {
    expect(selectedEffort([{ id: "reasoningEffort", value: "high" }])).toBe("high");
    expect(
      selectedEffort([
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ]),
    ).toBe("max");
  });

  it("is undefined when the agent runs at the model default", () => {
    expect(selectedEffort(undefined)).toBeUndefined();
    expect(selectedEffort([{ id: "fastMode", value: true }])).toBeUndefined();
  });
});

describe("withoutEffort", () => {
  it("drops only the effort choice so a child starts at its model default", () => {
    expect(
      withoutEffort({
        model: "m",
        options: [
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toEqual({ model: "m", options: [{ id: "fastMode", value: true }] });
    expect(
      withoutEffort({ model: "m", options: [{ id: "reasoningEffort", value: "low" }] }),
    ).toEqual({ model: "m" });
  });
});
