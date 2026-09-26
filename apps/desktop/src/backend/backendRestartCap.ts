/**
 * ViewCode: stop restarting a backend that keeps being killed.
 *
 * On a managed machine an endpoint agent may kill the server every time it
 * starts; restarting it forever only produces more kills. After
 * `ABRUPT_EXIT_LIMIT` abrupt exits within `ABRUPT_EXIT_WINDOW_MS`, the
 * manager stops restarting and reports the reason instead.
 */
export const ABRUPT_EXIT_LIMIT = 3;
export const ABRUPT_EXIT_WINDOW_MS = 2 * 60 * 1000;

/** Records abrupt exits; `record` returns true once the limit is reached. */
export function makeAbruptExitTracker(limit = ABRUPT_EXIT_LIMIT, windowMs = ABRUPT_EXIT_WINDOW_MS) {
  let exits: ReadonlyArray<number> = [];
  return {
    record(nowMs: number): boolean {
      exits = [...exits.filter((at) => nowMs - at < windowMs), nowMs];
      return exits.length >= limit;
    },
  };
}
