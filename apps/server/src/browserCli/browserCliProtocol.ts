/**
 * What the `viewcode-browser` CLI and `POST /api/browser` share. Kept free of
 * Effect so the CLI starts fast.
 *
 * A request names one `preview_*` tool and its input, exactly as the MCP
 * preview tools take it; the server validates the input with the same
 * schemas and runs the same handlers.
 */
export const BROWSER_CLI_ROUTE_PATH = "/api/browser";

/** `http://…/api/browser`, or `unix:<socket path>` when the server listens on a socket only. */
export const BROWSER_ENDPOINT_ENV = "VIEWCODE_BROWSER_ENDPOINT";
/**
 * The session's bearer credential. Named without KEY/SECRET/TOKEN because
 * Codex strips such variables from the shell environment.
 */
export const BROWSER_AUTH_ENV = "VIEWCODE_BROWSER_AUTH";

export const BROWSER_CLI_NAME = "viewcode-browser";

export const BROWSER_CLI_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
] as const;
export type BrowserCliTool = (typeof BROWSER_CLI_TOOLS)[number];

export interface BrowserCliRequest {
  readonly tool: BrowserCliTool;
  readonly input: Record<string, unknown>;
}

export interface BrowserCliError {
  /** The preview error tag (e.g. `PreviewAutomationNoAvailableHostError`) or a CLI/route code. */
  readonly code: string;
  readonly message: string;
}

export type BrowserCliResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: BrowserCliError };
