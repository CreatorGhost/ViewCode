import type { SDKAPIRetryMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The work-log row for Claude's `api_retry` notice. Every retry of one turn
 * shares one row (the adapter reuses the activity id), so a 529 storm reads as
 * a single line whose attempt count climbs, not ten warnings. The detail keeps
 * upstream's wording ("Claude API overloaded. Retrying in 5s.").
 */
export function describeClaudeApiRetry(message: SDKAPIRetryMessage): {
  readonly message: string;
  readonly detail: string;
} {
  const attempt = Math.max(1, Math.trunc(message.attempt));
  const maxRetries = Math.max(attempt, Math.trunc(message.max_retries));
  const cause =
    typeof message.error_status === "number"
      ? `HTTP ${Math.trunc(message.error_status)}`
      : "no response";
  const errorName =
    typeof message.error === "string" ? message.error.replaceAll("_", " ") : "request failed";
  const delayMs = Math.max(0, Math.trunc(message.retry_delay_ms));
  const retryIn =
    delayMs === 0
      ? ""
      : delayMs < 1_000
        ? ` Retrying in ${delayMs}ms.`
        : ` Retrying in ${(delayMs / 1_000).toFixed(1).replace(/\.0$/u, "")}s.`;
  return {
    message: `Claude API retrying (attempt ${attempt} of ${maxRetries}, ${cause})`,
    detail: `Claude API ${errorName}.${retryIn}`,
  };
}
