import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * ViewCode: add a Codex or Claude account from Settings and sign it in through
 * a server-side terminal. The server owns the paths (state dir, home dirs), so
 * the account lands on the environment that runs it. Sign-in itself is not
 * always remote-safe: `codex login` finishes through a browser callback on the
 * server's own localhost (port 1455), which a browser on another machine
 * cannot reach.
 */
export const ProviderAccountDriver = Schema.Literals(["codex", "claudeAgent"]);
export type ProviderAccountDriver = typeof ProviderAccountDriver.Type;

export const ProviderAccountAddInput = Schema.Struct({
  driver: ProviderAccountDriver,
  instanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  accentColor: Schema.optional(TrimmedNonEmptyString),
  /** Reference this directory instead of creating a managed home. */
  existingDirectory: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderAccountAddInput = typeof ProviderAccountAddInput.Type;

export const ProviderAccountAddResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** CODEX_HOME / CLAUDE_CONFIG_DIR the account was given. */
  homePath: Schema.String,
  shadowHomePath: Schema.optional(Schema.String),
});
export type ProviderAccountAddResult = typeof ProviderAccountAddResult.Type;

export const ProviderAccountSignInInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderAccountSignInInput = typeof ProviderAccountSignInInput.Type;

/** What the client needs to open a terminal that runs the instance's login. */
export const ProviderAccountSignInPlan = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** An empty directory on the server to run the login in. */
  cwd: TrimmedNonEmptyString,
  /** The command to pre-type, e.g. `codex login` or `claude auth login`. */
  command: TrimmedNonEmptyString,
});
export type ProviderAccountSignInPlan = typeof ProviderAccountSignInPlan.Type;

export class ProviderAccountError extends Schema.TaggedError<ProviderAccountError>()(
  "ProviderAccountError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
