import { describe, expect, it } from "vite-plus/test";

import { advanceBlurSwap, initialBlurSwap } from "./blur-swap.logic";

describe("blur swap", () => {
  it("leaves content that mounts with the page still", () => {
    expect(initialBlurSwap("Commit", false).swaps).toBe(0);
  });

  it("animates a first mount that is itself a state change", () => {
    expect(initialBlurSwap("Pushing...", true).swaps).toBe(1);
  });

  it("remounts on every change of key, including a return to an earlier one", () => {
    const pushed = advanceBlurSwap(initialBlurSwap("Commit", false), "Push");
    const back = advanceBlurSwap(pushed, "Commit");
    expect([pushed.swaps, back.swaps]).toEqual([1, 2]);
  });

  it("keeps the same state while the key holds, so a re-render does not replay the swap", () => {
    const state = advanceBlurSwap(initialBlurSwap(3, false), 4);
    expect(advanceBlurSwap(state, 4)).toBe(state);
  });
});
