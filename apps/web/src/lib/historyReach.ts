/**
 * How far forward the app's history reaches, for the title bar's forward arrow. The browser does
 * not expose its forward stack, so the furthest entry index seen is tracked from the router's
 * history events: a new page (push) drops everything ahead of it, moving back or forward keeps it.
 * After a reload the reach starts at the current entry, so forward reads as unavailable until
 * the user goes back again.
 */
export type HistoryMove = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";

export function nextHistoryReach(reach: number, move: HistoryMove, index: number): number {
  return move === "PUSH" ? index : Math.max(reach, index);
}
