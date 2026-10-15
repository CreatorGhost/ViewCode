/**
 * What the `viewcode-review` CLI and `POST /api/review-findings` share. Kept
 * free of Effect so the CLI starts fast.
 *
 * A request body is exactly the `submit_review_findings` MCP tool's input; the
 * server validates it with the same schema and runs the same handler.
 */
export const REVIEW_CLI_ROUTE_PATH = "/api/review-findings";

/** `http://…/api/review-findings`, or `unix:<socket path>` when the server listens on a socket only. */
export const REVIEW_ENDPOINT_ENV = "VIEWCODE_REVIEW_ENDPOINT";
/**
 * The session's bearer credential. Named without KEY/SECRET/TOKEN because
 * Codex strips such variables from the shell environment.
 */
export const REVIEW_AUTH_ENV = "VIEWCODE_REVIEW_AUTH";

export const REVIEW_CLI_NAME = "viewcode-review";

export interface ReviewCliError {
  /** The tool's error tag (e.g. `ReviewFindingsTargetMissingError`) or a CLI/route code. */
  readonly code: string;
  readonly message: string;
}

export type ReviewCliResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ReviewCliError };
