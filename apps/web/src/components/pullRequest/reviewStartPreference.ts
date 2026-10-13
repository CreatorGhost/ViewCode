import { AgentReviewMode, LocalReviewScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The depth and "What to review" a reader last started a review with, remembered on this device
 * so the form opens on them. A commit is not remembered: the next review is rarely of the same one.
 */
export interface ReviewStartPreference {
  readonly mode: AgentReviewMode;
  readonly scope: LocalReviewScope | null;
}

const STORAGE_KEY = "viewcode:agent-review-start:v1";
const DEFAULT_PREFERENCE: ReviewStartPreference = { mode: "quick", scope: null };

const isMode = Schema.is(AgentReviewMode);
const isScope = Schema.is(LocalReviewScope);

/** What was stored, or the first-time default (Quick, Auto) for anything unreadable. */
export function parseReviewStartPreference(raw: string | null): ReviewStartPreference {
  if (raw === null) return DEFAULT_PREFERENCE;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return DEFAULT_PREFERENCE;
    const { mode, scope } = value as { mode?: unknown; scope?: unknown };
    return {
      mode: isMode(mode) ? mode : DEFAULT_PREFERENCE.mode,
      scope: isScope(scope) && scope.kind !== "commit" ? scope : null,
    };
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function serializeReviewStartPreference(preference: ReviewStartPreference): string {
  const scope = preference.scope?.kind === "commit" ? null : preference.scope;
  return JSON.stringify({ mode: preference.mode, scope });
}

export function readReviewStartPreference(): ReviewStartPreference {
  try {
    return parseReviewStartPreference(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function writeReviewStartPreference(preference: ReviewStartPreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeReviewStartPreference(preference));
  } catch {
    // A private window or blocked storage only costs the remembered choice.
  }
}
