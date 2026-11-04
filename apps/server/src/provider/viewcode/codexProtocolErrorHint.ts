import * as CodexErrors from "effect-codex-app-server/errors";
import * as Schema from "effect/Schema";

const isProtocolParseError = Schema.is(CodexErrors.CodexAppServerProtocolParseError);

/** Invalid JSON cannot establish which CLI version ran or whether a wrapper printed it. */
export function codexProtocolErrorHint(error: unknown): string | undefined {
  return isProtocolParseError(error) && error.operation === "decode-wire-message"
    ? "Codex returned invalid app-server output. Update the Codex CLI, or select a current executable in Settings → Providers → Codex → Binary path."
    : undefined;
}
