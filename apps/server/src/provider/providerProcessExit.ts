/**
 * User-facing wording for a provider CLI that exited on its own. The message
 * names the provider process and carries its stderr, so a dead process is not
 * reported as whichever request happened to touch it first.
 *
 * @module provider/providerProcessExit
 */
import { sanitizeAcpStderrExcerpt } from "./acp/AcpStderr.ts";

/** How much of the provider's stderr a user-facing error carries. */
export const PROVIDER_STDERR_EXCERPT_MAX_CHARS = 2_000;

export interface ProviderProcessExit {
  readonly code?: number | undefined;
  readonly signal?: string | undefined;
  readonly stderr?: string | undefined;
}

/** "Claude Code exited (code 1): <stderr>", with the stderr trimmed to its last ~2KB and redacted. */
export function formatProviderProcessExit(
  providerLabel: string,
  exit: ProviderProcessExit,
  environment?: NodeJS.ProcessEnv,
): string {
  const status =
    exit.code !== undefined
      ? `code ${exit.code}`
      : exit.signal !== undefined
        ? `signal ${exit.signal}`
        : "unknown status";
  const sanitized = sanitizeAcpStderrExcerpt(exit.stderr ?? "", environment);
  const stderr =
    sanitized.length > PROVIDER_STDERR_EXCERPT_MAX_CHARS
      ? `…${sanitized.slice(-PROVIDER_STDERR_EXCERPT_MAX_CHARS).trimStart()}`
      : sanitized;
  return stderr.length > 0
    ? `${providerLabel} exited (${status}): ${stderr}`
    : `${providerLabel} exited (${status}).`;
}

// The Claude Agent SDK words a non-zero exit as "Claude Code process exited
// with code 1. stderr: …" (or "terminated by signal SIGKILL"), sometimes
// wrapped ("Cannot write to process that exited with error: …").
const CLAUDE_PROCESS_EXIT =
  /Claude Code process (?:exited with code (-?\d+)|terminated by signal ([A-Z0-9]+))(?:\. stderr: ([\s\S]*))?/;

/** The Claude CLI's exit status and stderr tail, found anywhere in an error's cause chain. */
export function findClaudeProcessExit(cause: unknown): ProviderProcessExit | undefined {
  let current: unknown = cause;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object" && "message" in current
          ? String((current as { message: unknown }).message)
          : typeof current === "string"
            ? current
            : "";
    const match = CLAUDE_PROCESS_EXIT.exec(message);
    if (match) {
      return {
        ...(match[1] !== undefined ? { code: Number(match[1]) } : {}),
        ...(match[2] !== undefined ? { signal: match[2] } : {}),
        ...(match[3] !== undefined ? { stderr: match[3] } : {}),
      };
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return undefined;
}

// What the SDK says when a request reaches a CLI that is gone.
const CLAUDE_QUERY_GONE =
  /Query closed before response received|Claude Code process (?:exited|terminated)|Cannot write to (?:terminated process|process that exited)|ProcessTransport is not ready for writing/i;

/** Whether a failed Claude control request failed because the CLI is no longer running. */
export function isClaudeQueryGone(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return CLAUDE_QUERY_GONE.test(message) || findClaudeProcessExit(cause) !== undefined;
}
