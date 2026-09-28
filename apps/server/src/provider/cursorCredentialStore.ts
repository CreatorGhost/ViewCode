// Node APIs are required by the native Keychain bridge and its non-secret login revision.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
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

const requireForKeyring = NodeModule.createRequire(import.meta.url);

/** Cache outcomes until login changes or an explicit retry; refreshing usage must not prompt. */
export function makeCachedCursorAccessTokenReader(
  read: () => Promise<string | null>,
  readLoginRevision: () => Promise<string> = async () => "process",
) {
  let revision: string | undefined;
  let cached: Promise<string | null> | null = null;
  let rejectedToken: string | undefined;
  const invalidate = () => {
    cached = null;
    rejectedToken = undefined;
  };
  const reader = async () => {
    // A missing/unreadable config fails closed rather than serving the previous account.
    let currentRevision: string;
    try {
      currentRevision = await readLoginRevision();
    } catch (cause) {
      invalidate();
      revision = undefined;
      throw cause;
    }
    if (revision !== currentRevision) {
      invalidate();
      revision = currentRevision;
    }
    cached ??= Promise.resolve().then(read);
    return cached;
  };
  return Object.assign(reader, {
    invalidate,
    rejectToken(token: string) {
      // Re-read once after a server rejection. An unchanged rejected item must not
      // reopen Keychain every maintenance pass while the user remains signed out.
      if (rejectedToken === token) return;
      cached = null;
      rejectedToken = token;
    },
  });
}

/** Read the CLI account only. The editor may be signed into an unrelated account. */
export const readMacCursorAccessToken = makeCachedCursorAccessTokenReader(
  async () => {
    const { AsyncEntry } = requireForKeyring(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring");
    const token =
      (await new AsyncEntry("cursor-access-token", "cursor-user").getPassword()) ?? null;
    if (token && !cursorTokenMatchesIdentity(token, await readCliIdentity())) {
      throw new Error("Cursor Keychain login does not match the CLI account");
    }
    return token;
  },
  // Login identity, not file mtime: Cursor also writes ordinary preferences here.
  readCliIdentity,
);
