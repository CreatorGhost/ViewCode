// Node APIs are required by the native Keychain bridge and its non-secret login revision.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const CursorCliConfig = Schema.Struct({
  authInfo: Schema.Struct({ authId: Schema.String }),
});
const decodeCliConfig = Schema.decodeSync(Schema.fromJsonString(CursorCliConfig));
const decodeTokenClaims = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);

export function cursorCliLoginIdentity(config: string) {
  const identity = decodeCliConfig(config).authInfo.authId.trim();
  if (!identity) throw new Error("Cursor CLI login identity is missing");
  return identity;
}

export function cursorTokenMatchesIdentity(token: string, identity: string) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    return decodeTokenClaims(Buffer.from(payload, "base64url").toString("utf8")).sub === identity;
  } catch {
    return false;
  }
}

const readCliIdentity = async () =>
  cursorCliLoginIdentity(
    await NodeFSP.readFile(NodePath.join(NodeOS.homedir(), ".cursor", "cli-config.json"), "utf8"),
  );

import { makeCachedKeychainSecretReader, readKeychainPassword } from "./keychainSecret.ts";

/** Read the CLI account only. The editor may be signed into an unrelated account. */
export const readMacCursorAccessToken = makeCachedKeychainSecretReader(
  async () => {
    const token = await readKeychainPassword("cursor-access-token", "cursor-user");
    if (token && !cursorTokenMatchesIdentity(token, await readCliIdentity())) {
      throw new Error("Cursor Keychain login does not match the CLI account");
    }
    return token;
  },
  // Login identity, not file mtime: Cursor also writes ordinary preferences here.
  readCliIdentity,
);
