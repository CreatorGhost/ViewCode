// Node APIs are required by the native Keychain bridge and its non-secret login revision.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { makeCachedKeychainSecretReader, readKeychainPassword } from "./cursorCredentialStore.ts";

/**
 * Where Claude Code keeps its OAuth login on macOS when no `CLAUDE_CONFIG_DIR`
 * is set: a generic password whose account is the login user (`$USER`, else
 * the OS user name; names outside `[A-Za-z0-9._-]` fall back to
 * `claude-code-user`). Any `CLAUDE_CONFIG_DIR` makes the CLI suffix the
 * service, so callers read this item for the default config directory only.
 *
 * Taken from the bundled Agent SDK, NOT yet confirmed by a working read on a
 * real Mac. Confirm with `security find-generic-password -s "Claude Code-credentials"`
 * (attributes only; never pass `-w`, which prints the secret).
 */
export const CLAUDE_KEYCHAIN_ITEM = {
  service: "Claude Code-credentials",
  account: () => {
    let user: string;
    try {
      user = process.env.USER || NodeOS.userInfo().username;
    } catch {
      return "claude-code-user";
    }
    return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
  },
} as const;

const decodeAccount = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.optional(
        Schema.Struct({
          accountUuid: Schema.optional(Schema.String),
          organizationUuid: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** Account identity, not file mtime: the CLI rewrites `~/.claude.json` constantly. */
const readClaudeLoginRevision = async () => {
  let config: string;
  try {
    config = await NodeFSP.readFile(NodePath.join(NodeOS.homedir(), ".claude.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "signed-out";
    throw cause;
  }
  const account = decodeAccount(config).oauthAccount;
  return `${account?.accountUuid ?? ""}:${account?.organizationUuid ?? ""}`;
};

/** The default config directory's login, read at most once per Claude account. */
export const readMacClaudeCredentials = makeCachedKeychainSecretReader(
  () => readKeychainPassword(CLAUDE_KEYCHAIN_ITEM.service, CLAUDE_KEYCHAIN_ITEM.account()),
  readClaudeLoginRevision,
);
