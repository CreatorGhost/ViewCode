// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
const requireForKeyring = NodeModule.createRequire(import.meta.url);

/** One generic-password item from the login Keychain, or null when it does not exist. */
export async function readKeychainPassword(service: string, account: string) {
  const { AsyncEntry } = requireForKeyring("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return (await new AsyncEntry(service, account).getPassword()) ?? null;
}

/**
 * Cache outcomes until login changes or an explicit retry; refreshing usage must not prompt.
 * Shared by every Keychain-backed provider login (Cursor, Claude).
 */
export function makeCachedKeychainSecretReader(
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

export type KeychainSecretReader = ReturnType<typeof makeCachedKeychainSecretReader>;
