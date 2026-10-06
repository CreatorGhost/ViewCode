/**
 * Why a provider turn failed, in six classes, from the error text the
 * provider reported. Providers report failures only as text; Cursor's carry a
 * Connect/gRPC code in brackets (`RetriableError: [invalid_argument] …`,
 * `ConnectError: [permission_denied] …`), which is the most reliable signal
 * and is checked first.
 *
 * `retryable` says whether trying the same request again can succeed without
 * the user changing anything. It is advice for wording, not a retry policy.
 */
import { classifyLimitError } from "./usageLimit.ts";

export type ProviderFailureClass =
  | "usage_limit"
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

export interface ProviderFailure {
  readonly class: ProviderFailureClass;
  /** The provider's own text, unchanged. */
  readonly message: string;
  /** The bracketed Connect/gRPC code, when the provider reported one. */
  readonly code: string | null;
  readonly retryable: boolean;
}

const CONNECT_CODE = /\[([a-z_]+)\]/;

// The account or organisation may not use this model: a managed gateway's
// entitlement rejection. Kept to phrasings that name a model or an
// organisation so an unrelated "not enabled" (a setting, a feature) stays out.
const ENTITLEMENT_PATTERN =
  /\bmodel\b[^\n]{0,80}\b(?:is not|isn't|not) (?:enabled|available|allowed|permitted|supported)\b|\b(?:not (?:enabled|available|allowed)|disabled) for (?:your|this) (?:team|organi[sz]ation|org|account|workspace|enterprise)\b|(?:do(?:es)? not|don't) have access to (?:the |this )?model|model_not_(?:enabled|allowed|permitted|available)/i;

const OVERSIZED_PATTERN =
  /payload too large|request (?:entity )?too large|\b413\b|too many images|image[^\n]{0,40}too large|exceeds? the maximum (?:request|payload|body) size/i;

const TRANSPORT_PATTERN =
  /WritableIterable is closed|communicating with the server|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bETIMEDOUT\b|\bEPIPE\b|socket hang up|fetch failed|network (?:error|connection)|connection (?:reset|closed|lost|refused)/i;

const SERVER_PATTERN =
  /\b5\d\d\b[^\n]{0,40}(?:error|server|gateway|unavailable)|internal server error|bad gateway/i;

function failure(
  providerClass: ProviderFailureClass,
  message: string,
  code: string | null,
  retryable: boolean,
): ProviderFailure {
  return { class: providerClass, message, code, retryable };
}

export function classifyProviderFailure(message: string): ProviderFailure {
  const code = CONNECT_CODE.exec(message)?.[1] ?? null;
  // The usage-limit matcher is shared with usage resume; it decides first so
  // the two never disagree about whether to wait for a reset.
  const limit = classifyLimitError(message);
  if (limit === "usage") return failure("usage_limit", message, code, false);
  if (limit === "transient") return failure("provider_error", message, code, true);
  if (ENTITLEMENT_PATTERN.test(message)) return failure("permission_error", message, code, false);
  switch (code) {
    case "permission_denied":
    case "unauthenticated":
      return failure("permission_error", message, code, false);
    case "invalid_argument":
    case "out_of_range":
    case "failed_precondition":
      // Cursor sometimes returns invalid_argument for a request that succeeds
      // when retried, and always for one that is too large. Neither can be
      // told apart from the text, so this stays retryable and the wording
      // names both.
      return failure("validation_error", message, code, true);
    case "unavailable":
    case "aborted":
    case "deadline_exceeded":
    case "canceled":
    case "cancelled":
      return failure("transport_error", message, code, true);
    case "internal":
    case "unknown":
    case "resource_exhausted":
    case "data_loss":
    case "unimplemented":
      return failure("provider_error", message, code, true);
  }
  if (OVERSIZED_PATTERN.test(message)) return failure("validation_error", message, code, false);
  if (TRANSPORT_PATTERN.test(message)) return failure("transport_error", message, code, true);
  if (SERVER_PATTERN.test(message)) return failure("provider_error", message, code, true);
  return failure("unknown", message, code, false);
}

/**
 * One sentence a user can act on, naming the provider and, for an
 * entitlement rejection, the model. The provider's own text stays available
 * in `failure.message` for anyone who needs it.
 */
export function describeProviderFailure(
  failure: ProviderFailure,
  input: { readonly provider: string; readonly model?: string | null | undefined },
): string {
  const { provider } = input;
  const model = input.model ? `the model "${input.model}"` : "this model";
  switch (failure.class) {
    case "permission_error":
      return failure.code === "unauthenticated"
        ? `${provider} rejected the request because you are not signed in. Sign in to ${provider} and try again.`
        : `${provider} refused the request: this account or organisation may not be allowed to use ${model}. Choose another model and send the message again.`;
    case "validation_error":
      return `${provider} rejected the request as invalid. This sometimes clears when retried. If it keeps happening, the conversation is probably too large for ${provider}: images are resent on every turn, so a thread with many of them can stop working. Start a new thread to continue.`;
    case "transport_error":
      return `${provider} lost the connection to its servers before answering. Send the message again.`;
    case "provider_error":
      return `${provider}'s servers reported an error. Send the message again in a moment.`;
    case "usage_limit":
      return `${provider} reports that this account's usage limit is reached.`;
    case "unknown":
      return `${provider} reported an error.`;
  }
}
