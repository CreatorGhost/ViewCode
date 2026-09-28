import * as NodeZlib from "node:zlib";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const HEADER_BYTES = 24;
const MAX_KEY_BYTES = 4096;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const FRESH_MS = 5 * 60_000;
const decodeAccount = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.Struct({ organizationUuid: Schema.String }),
    }),
  ),
);
const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      cedar_ember: Schema.Unknown,
    }),
  ),
);
const decodeInflated = Schema.decodeUnknownOption(
  Schema.Struct({
    buffer: Schema.Uint8Array,
    engine: Schema.Struct({ bytesWritten: Schema.Int.check(Schema.isGreaterThan(0)) }),
  }),
);

function usageKey(bytes: Uint8Array, organization: string) {
  if (bytes.length < HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0, true) !== 0xfcfb6d1ba7725c30n) return undefined;
  const length = view.getUint32(12, true);
  if (!length || length > MAX_KEY_BYTES || HEADER_BYTES + length > bytes.length) return undefined;
  const key = new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length));
  const start = key.indexOf("https://");
  if (start < 0) return undefined;
  try {
    const url = new URL(key.slice(start));
    if (
      url.origin !== "https://claude.ai" ||
      url.pathname !== `/api/organizations/${organization}/usage`
    )
      return undefined;
    return { bodyStart: HEADER_BYTES + length };
  } catch {
    return undefined;
  }
}

/** Chromium Simple Cache layout, as used by CodeNotch; only the matching usage body is decoded. */
export function parseClaudeDesktopResetCache(input: {
  readonly bytes: Uint8Array;
  readonly organization: string;
  readonly modifiedAtMs: number;
  readonly nowMs: number;
}) {
  const { bytes, organization, modifiedAtMs, nowMs } = input;
  if (bytes.length > MAX_ENTRY_BYTES) return undefined;
  const key = usageKey(bytes, organization);
  if (!key || bytes.length < key.bodyStart + 4) return undefined;
  const body = bytes.subarray(key.bodyStart);
  if (new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true) !== 0xfd2fb528)
    return undefined;
  try {
    // info exposes consumed bytes, so the response Date is read only after the compressed frame.
    const inflated = decodeInflated(
      NodeZlib.zstdDecompressSync(body, {
        info: true,
        maxOutputLength: MAX_BODY_BYTES,
        params: { [NodeZlib.constants.ZSTD_d_windowLogMax]: 20 },
      }),
    );
    if (Option.isNone(inflated)) return undefined;
    const trailer = new TextDecoder().decode(body.subarray(inflated.value.engine.bytesWritten));
    const date = /\0date:\s*([^\0]+)\0/i.exec(trailer)?.[1];
    const observed = DateTime.make(date ?? modifiedAtMs);
    if (Option.isNone(observed)) return undefined;
    const capturedAt = DateTime.toEpochMillis(observed.value);
    if (capturedAt > nowMs || nowMs - capturedAt > FRESH_MS) return undefined;
    const payload = decodePayload(new TextDecoder().decode(inflated.value.buffer));
    return Option.isSome(payload) ? { block: payload.value.cedar_ember, capturedAt } : undefined;
  } catch {
    return undefined;
  }
}

/** Fresh, account-matched Desktop data only. Never reads cookies, credentials, or unrelated bodies. */
export const readClaudeDesktopResetCache = Effect.fn("readClaudeDesktopResetCache")(
  function* (input: { readonly accountConfigPath: string; readonly cacheDirectory: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const account = yield* fs
      .readFileString(input.accountConfigPath)
      .pipe(Effect.flatMap(decodeAccount));
    const organization = account.oauthAccount.organizationUuid.trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(organization)) return undefined;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const names = (yield* fs.readDirectory(input.cacheDirectory))
      .filter((name) => /^[a-f0-9]+_0$/.test(name))
      .slice(0, 20_000);
    const candidates = yield* Effect.forEach(
      names,
      (name) =>
        fs.stat(path.join(input.cacheDirectory, name)).pipe(
          Effect.map((info) => ({
            name,
            info,
            modified: Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0,
          })),
          Effect.option,
        ),
      { concurrency: 32 },
    );
    const recent = candidates
      .flatMap(Option.toArray)
      .filter(
        ({ info, modified }) =>
          info.type === "File" &&
          info.size <= BigInt(MAX_ENTRY_BYTES) &&
          modified >= nowMs - FRESH_MS,
      )
      .toSorted((a, b) => b.modified - a.modified)
      .slice(0, 512);
    let latest: ReturnType<typeof parseClaudeDesktopResetCache>;
    for (const candidate of recent) {
      const reading = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path.join(input.cacheDirectory, candidate.name), {
            flag: "r",
          });
          const head = yield* file.readAlloc(HEADER_BYTES + MAX_KEY_BYTES);
          if (Option.isNone(head) || !usageKey(head.value, organization)) return undefined;
          const info = yield* file.stat;
          if (info.size > BigInt(MAX_ENTRY_BYTES) || Option.isNone(info.mtime)) return undefined;
          yield* file.seek(0n, "start");
          const bytes = yield* file.readAlloc(MAX_ENTRY_BYTES);
          return Option.isSome(bytes)
            ? parseClaudeDesktopResetCache({
                bytes: bytes.value,
                organization,
                modifiedAtMs: info.mtime.value.getTime(),
                nowMs,
              })
            : undefined;
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (reading && (!latest || reading.capturedAt > latest.capturedAt)) latest = reading;
    }
    return latest;
  },
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => undefined),
);
