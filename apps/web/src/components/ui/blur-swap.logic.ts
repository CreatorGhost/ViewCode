export type BlurSwapKey = string | number | boolean | null | undefined;

export interface BlurSwapState {
  readonly key: BlurSwapKey;
  /** How many times the key has changed; it keys the remount, and above 0 the swap animates. */
  readonly swaps: number;
}

/**
 * What mounts with the page stays still, so a reload or a thread switch does not blur every
 * label at once. `appear` is for content that only mounts because its state just changed.
 */
export function initialBlurSwap(key: BlurSwapKey, appear: boolean): BlurSwapState {
  return { key, swaps: appear ? 1 : 0 };
}

export function advanceBlurSwap(state: BlurSwapState, key: BlurSwapKey): BlurSwapState {
  return Object.is(state.key, key) ? state : { key, swaps: state.swaps + 1 };
}
