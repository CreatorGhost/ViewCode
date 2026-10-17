/**
 * Claude banked resets (the CLI's `cedar_ember` program). The CLI reads the
 * grants from the OAuth usage endpoint and claims one against the
 * organization; this module does the same with the credentials the CLI keeps
 * in its config directory. macOS keeps them in the Keychain, read only after
 * the user opts in (`claudeKeychainUsageEnabled`) because macOS may ask on the
 * server's screen. Otherwise only a fresh, account-matched Desktop cache may
 * supply a read-only count without prompting.
 *
 * @module provider/Layers/claudeResetCredits
 */
import * as NodeOS from "node:os";
import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { readMacClaudeCredentials } from "../claudeCredentialStore.ts";
import type { KeychainSecretReader } from "../cursorCredentialStore.ts";
import { readClaudeDesktopResetCache } from "./claudeDesktopResetCache.ts";

const API_BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(Credentials));
const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  starts_at: Schema.optional(Schema.NullOr(Schema.String)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const ClaimResponse = Schema.Struct({
  result: Schema.Literals([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

const RESET_CREDIT_FAILURES = {
  malformedCredit: "Claude returned a malformed reset credit.",
  loginUnreadable: "Claude could not read its login.",
  accountUnreadable: "Claude could not read its account.",
  signedOut: "Sign in to Claude again to redeem resets.",
  rateLimited: "Claude is rate limiting resets. Try again soon.",
  coolingDown: "Claude resets are cooling down. Try again later.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
  requestFailed: "Claude could not redeem the reset.",
} as const;

class ClaudeResetCreditError extends Schema.TaggedError<ClaudeResetCreditError>()(
  "ClaudeResetCreditError",
  {
    reason: Schema.Literals(
      Object.keys(RESET_CREDIT_FAILURES) as Array<keyof typeof RESET_CREDIT_FAILURES>,
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_FAILURES[this.reason];
  }
}

const isClaudeResetCreditError = Schema.is(ClaudeResetCreditError);

/**
 * Every reset failure except `requestFailed` and `unconfirmed` is final:
 * Claude answered, or nothing was sent. An unanswered or unconfirmed claim
 * retries with the same request id.
 */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

/** Rejects unparseable and calendar-invalid timestamps such as February 30. */
const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

/** Banked grants count before a limit is reached; only the next usable grant may be redeemed. */
export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const live = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused &&
        grant.resets_left > 0 &&
        (grant.starts_at == null ||
          (isFutureTimestamp(grant.starts_at, Number.NEGATIVE_INFINITY) &&
            Date.parse(grant.starts_at) <= nowMs)) &&
        (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const next = live.find((grant) => grant.usable_now && grant.id === parsed.value.next_grant_id);
  const availableCount = live.reduce((sum, grant) => sum + grant.resets_left, 0);
  if (!Number.isSafeInteger(availableCount)) return undefined;
  const nextExpiresAt = next?.ends_at ? DateTime.make(next.ends_at) : Option.none();
  return {
    availableCount,
    canRedeem: !!next,
    ...(Option.isSome(nextExpiresAt)
      ? { nextExpiresAt: DateTime.formatIso(nextExpiresAt.value) }
      : {}),
    ...(next ? { nextCreditId: next.id } : {}),
  };
}

const readJson = <S extends Schema.Top>(schema: S, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    );
  });

/** Shown where banked resets would be, so an unreadable login never looks like zero. */
const RESET_CREDITS_UNAVAILABLE = {
  keychainOff: "Turn on Claude account usage in Settings → Providers to see banked resets.",
  customConfigDir: "Banked resets on macOS need Claude's default config directory.",
  keychainUnreadable: "ViewCode could not read Claude's login from the Keychain.",
  noKeychainLogin: "No Claude login was found in the Keychain.",
  loginExpired: "Claude's login has expired. Use Claude once to refresh it.",
} as const;

/** How this instance may reach Claude's macOS Keychain login. */
export interface ClaudeKeychainAccess {
  /** `claudeKeychainUsageEnabled`; off never touches the Keychain. */
  readonly enabled: boolean;
  /** False when a custom config directory makes the CLI use a differently named item. */
  readonly defaultItem: boolean;
  readonly read?: KeychainSecretReader;
}

const KEYCHAIN_OFF: ClaudeKeychainAccess = { enabled: false, defaultItem: true };

/** The CLI suffixes its Keychain service for any `CLAUDE_CONFIG_DIR`; only the default item is known. */
export const usesDefaultClaudeKeychainItem = (homePath: string, environment: NodeJS.ProcessEnv) =>
  !homePath.trim() &&
  !environment.CLAUDE_CONFIG_DIR?.trim() &&
  environment.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined;

/** Long enough to answer a macOS access prompt, and never longer. */
const KEYCHAIN_READ_TIMEOUT = "30 seconds";
/** Claude Code refreshes an expired login when it next runs; look again at most this often. */
const EXPIRED_LOGIN_RETRY_MS = 15 * 60_000;
const expiredLoginRetries = new WeakMap<KeychainSecretReader, number>();

interface ClaudeLogin {
  readonly token?: string;
  readonly expiresAt?: number;
  /** Re-reads the Keychain once after Claude refuses the token. */
  readonly reject?: () => void;
  readonly unavailableReason?: string;
}

const readKeychainLogin = (read: KeychainSecretReader) =>
  Effect.tryPromise(() => read()).pipe(
    Effect.timeout(KEYCHAIN_READ_TIMEOUT),
    Effect.option,
    Effect.map((secret): ClaudeLogin => {
      if (Option.isNone(secret)) {
        return { unavailableReason: RESET_CREDITS_UNAVAILABLE.keychainUnreadable };
      }
      const raw = secret.value;
      if (raw === null) return { unavailableReason: RESET_CREDITS_UNAVAILABLE.noKeychainLogin };
      const credentials = decodeCredentials(raw);
      if (Option.isNone(credentials)) {
        return { unavailableReason: RESET_CREDITS_UNAVAILABLE.keychainUnreadable };
      }
      const oauth = credentials.value.claudeAiOauth;
      const token = oauth?.accessToken?.trim();
      if (!token) return { unavailableReason: RESET_CREDITS_UNAVAILABLE.noKeychainLogin };
      return {
        token,
        ...(typeof oauth?.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
        reject: () => read.rejectToken(raw),
      };
    }),
  );

const readMacLogin = (read: KeychainSecretReader) =>
  Effect.gen(function* () {
    const login = yield* readKeychainLogin(read);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (login.expiresAt === undefined || login.expiresAt > nowMs) return login;
    const lastRetry = expiredLoginRetries.get(read) ?? Number.NEGATIVE_INFINITY;
    const retried =
      nowMs - lastRetry >= EXPIRED_LOGIN_RETRY_MS
        ? yield* Effect.suspend(() => {
            expiredLoginRetries.set(read, nowMs);
            read.invalidate();
            return readKeychainLogin(read);
          })
        : login;
    return retried.expiresAt !== undefined && retried.expiresAt <= nowMs
      ? { unavailableReason: RESET_CREDITS_UNAVAILABLE.loginExpired }
      : retried;
  });

/** The CLI's login: the Keychain on macOS (opt-in), `.credentials.json` elsewhere. */
const readLogin = (
  configDir: string,
  environment: NodeJS.ProcessEnv,
  keychain: ClaudeKeychainAccess,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if ((yield* HostProcessPlatform) === "darwin") {
      // Another HOME may belong to another macOS user's login.
      const instanceHome = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
      if (!keychain.defaultItem || path.resolve(instanceHome) !== path.resolve(NodeOS.homedir())) {
        return { unavailableReason: RESET_CREDITS_UNAVAILABLE.customConfigDir };
      }
      if (!keychain.enabled) return { unavailableReason: RESET_CREDITS_UNAVAILABLE.keychainOff };
      return yield* readMacLogin(keychain.read ?? readMacClaudeCredentials);
    }
    const credentials = yield* readJson(Credentials, path.join(configDir, ".credentials.json"));
    const token = credentials.claudeAiOauth?.accessToken?.trim();
    return token ? { token } : {};
  });

const withClaudeHeaders = (token: string, version: string) =>
  HttpClientRequest.setHeaders({
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `claude-cli/${version} (external, cli)`,
  });

/** Banked resets, or why they could not be read when that is known. */
export interface ClaudeResetCreditsReading {
  readonly credits?: ServerProviderResetCredits;
  readonly unavailableReason?: string;
}

/** A read-only count from Claude Desktop's recent usage response, for this OS user only. */
const readDesktopResetCredits = (
  accountConfigPath: string | undefined,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    if (!accountConfigPath) return undefined;
    const path = yield* Path.Path;
    // Desktop belongs to this OS user; a provider running under another HOME
    // must not inherit its cached account even when the default config path matches.
    const instanceHome = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
    if (path.resolve(instanceHome) !== path.resolve(NodeOS.homedir())) return undefined;
    const cached = yield* readClaudeDesktopResetCache({
      accountConfigPath,
      cacheDirectory: path.join(
        NodeOS.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "Cache",
        "Cache_Data",
      ),
    });
    const credits = cached
      ? claudeResetCreditsToContract(cached.block, DateTime.toEpochMillis(yield* DateTime.now))
      : undefined;
    // A cached observation can display a count, never authorize spending a reset.
    return credits ? { availableCount: credits.availableCount, canRedeem: false } : undefined;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Reads banked resets for the selected account. Failure or missing evidence
 * returns unknown, never an invented zero, without interrupting usage windows;
 * a known cause comes back as `unavailableReason`.
 */
export const readClaudeResetCredits = Effect.fn("readClaudeResetCredits")(function* (
  configDir: string,
  version: string,
  accountConfigPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  keychain: ClaudeKeychainAccess = KEYCHAIN_OFF,
) {
  if ((yield* HostProcessPlatform) === "darwin" && !keychain.enabled) {
    const credits = yield* readDesktopResetCredits(accountConfigPath, environment);
    if (credits) return { credits } satisfies ClaudeResetCreditsReading;
  }
  const login = yield* readLogin(configDir, environment, keychain).pipe(
    Effect.orElseSucceed((): ClaudeLogin => ({})),
  );
  const token = login.token;
  if (!token) {
    return (
      login.unavailableReason ? { unavailableReason: login.unavailableReason } : {}
    ) satisfies ClaudeResetCreditsReading;
  }
  const credits = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    if (response.status === 401 || response.status === 403) login.reject?.();
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return claudeResetCreditsToContract(
      body.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  return (credits ? { credits } : {}) satisfies ClaudeResetCreditsReading;
});

/** The CLI keeps the account record beside its settings, or in the home directory by default. */
export const claudeAccountConfigPath = (configDir: string | undefined) =>
  Effect.map(Path.Path, (path) =>
    configDir ? path.join(configDir, ".claude.json") : path.join(NodeOS.homedir(), ".claude.json"),
  );

const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/**
 * Claims `grantId`. `requestId` is the idempotency key: a retry with the same
 * id is the same claim. Ids are checked before anything is sent.
 */
export const consumeClaudeResetCredit = Effect.fn("consumeClaudeResetCredit")(function* (input: {
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly keychain?: ClaudeKeychainAccess;
}) {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const login = yield* readLogin(
    input.configDir,
    input.environment ?? process.env,
    input.keychain ?? KEYCHAIN_OFF,
  ).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "loginUnreadable", cause })),
  );
  if (login.unavailableReason === RESET_CREDITS_UNAVAILABLE.keychainUnreadable) {
    return yield* new ClaudeResetCreditError({ reason: "loginUnreadable" });
  }
  const token = login.token;
  const config = yield* readJson(Config, input.accountConfigPath).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "accountUnreadable", cause })),
  );
  const organization = config.oauthAccount?.organizationUuid?.trim();
  if (!token || !organization) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(
        new URL(
          `/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
          API_BASE,
        ),
      ).pipe(
        withClaudeHeaders(token, input.version),
        HttpClientRequest.bodyJsonUnsafe({
          program: PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
      ),
    )
    .pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
  if (response.status === 429) {
    return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
  }
  if (response.status === 401 || response.status === 403) {
    login.reject?.();
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaimResponse)),
    Effect.timeout("25 seconds"),
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
  );
  if (body.result === "cooldown") {
    return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
  }
  // Claude could not say whether the claim landed, so, like the CLI, keep the
  // request id and let the retry ask about the same claim.
  if (body.result === "unavailable") {
    return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
  }
  return CLAIM_OUTCOMES[body.result];
});
