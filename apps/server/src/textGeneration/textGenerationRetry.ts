/**
 * ViewCode: which text generation failures are worth retrying.
 *
 * A provider CLI killed from outside (an endpoint agent's SIGKILL shows as
 * exit code 137, SIGTERM as 143) or refused before launch (disabled, not
 * chosen, executable missing) fails the same way on a retry, and on managed
 * machines each retry is one more launch to be killed for. Those fail once.
 */
import type { TextGenerationError } from "@t3tools/contracts";

const NOT_RETRYABLE =
  /\bcode (?:137|143)\b|SIGKILL|SIGTERM|not launched|not enabled|is disabled|choose your agents/i;

export function isRetryableTextGenerationError(error: TextGenerationError): boolean {
  return !NOT_RETRYABLE.test(error.detail);
}
