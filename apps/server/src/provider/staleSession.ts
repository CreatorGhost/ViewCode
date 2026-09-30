/**
 * Recognizes a provider refusing to resume a saved native session that no
 * longer exists (deleted, never written, other config dir or cwd). The
 * orchestration reactor then starts a fresh session with a handoff recap
 * instead of failing every send (see docs/internals/viewcode.md, Handoff).
 */
import * as Cause from "effect/Cause";

const STALE_SESSION_PATTERNS: ReadonlyArray<RegExp> = [
  // Claude Code CLI: `--resume <id>` for a transcript it cannot find, or
  // `--resume-session-at <uuid>` for a message that transcript lacks.
  /no conversation found with session id/i,
  /no message found with message\.uuid of/i,
  // ACP agents (Cursor, Grok, Antigravity) answering session/load or session/resume.
  /\bsession(?: [\w:.-]+)? (?:was )?not found\b/i,
  /session\/(?:load|resume)[\s\S]*\bresource not found\b/i,
];

export function isStaleProviderSessionText(text: string): boolean {
  return STALE_SESSION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Every message, detail and stderr string in an error and the causes it wraps. */
function collectErrorText(value: unknown, out: Array<string>, seen: Set<unknown>, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Cause.isCause(value)) {
    for (const reason of value.reasons) {
      collectErrorText(
        Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined,
        out,
        seen,
        depth + 1,
      );
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "stderr", "issue", "cause", "error"]) {
    collectErrorText(record[key], out, seen, depth + 1);
  }
}

export function isStaleProviderSessionCause(cause: Cause.Cause<unknown>): boolean {
  const text: Array<string> = [];
  collectErrorText(cause, text, new Set());
  return text.some(isStaleProviderSessionText);
}
