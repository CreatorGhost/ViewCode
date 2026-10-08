/**
 * Gives a Cloudflare account its workers.dev subdomain when it has none, so
 * Quick connect setup never sends the person to the dashboard to pick one.
 * These are the calls wrangler's own `registerSubdomain` makes (it only makes
 * them unprompted when it thinks an AI agent runs it): the account has none
 * (code 10007), a candidate name is free (10032; 10031 means taken), claim it.
 *
 * The token is wrangler's own sign-in (`wrangler auth token --json`). It goes
 * only into the Authorization header, which the HttpClient redacts from
 * traces, and never into an error message.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT = "15 seconds";
/** Taken names before giving up; a random suffix is rarely taken even once. */
const NAME_ATTEMPTS = 4;
const NAME_PREFIX = "viewcode-";
const NAME_SUFFIX_LENGTH = 6;
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const NO_SUBDOMAIN_REGISTERED = 10007;
const NAME_AVAILABLE = 10032;
const NAME_TAKEN = 10031;

/** `message` is safe to show: it names the request and Cloudflare's answer, never the token. */
export class WorkersDevSubdomainError extends Data.TaggedError("WorkersDevSubdomainError")<{
  readonly message: string;
}> {}

/** The JSON object in wrangler output, which may carry warnings around it. */
function jsonObjectIn(output: string): string {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start === -1 || end < start ? "" : output.slice(start, end + 1);
}

const decodeAuthToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literals(["oauth", "api_token"]), token: Schema.String }),
  ),
);

/**
 * The bearer token from `wrangler auth token --json`. Null for a Global API
 * Key (key and email, no token) or anything unreadable.
 */
export function parseWranglerAuthToken(output: string): string | null {
  return Option.match(decodeAuthToken(jsonObjectIn(output)), {
    onNone: () => null,
    onSome: ({ token }) => (token.trim() === "" ? null : token.trim()),
  });
}

const decodeWhoami = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ accounts: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  ),
);

/** The account ids in `wrangler whoami --json`; null when unreadable. */
export function parseWhoamiAccountIds(output: string): ReadonlyArray<string> | null {
  return Option.match(decodeWhoami(jsonObjectIn(output)), {
    onNone: () => null,
    onSome: ({ accounts }) => accounts.map((account) => account.id),
  });
}

/**
 * The account a deploy went to, from the dashboard link wrangler prints when
 * it declines to register a subdomain itself
 * (`https://dash.cloudflare.com/<account id>/workers/onboarding`).
 */
export function parseDeployAccountId(output: string): string | null {
  return (
    /dash\.cloudflare\.com\/([0-9a-f]{32})\/workers\/onboarding/iu
      .exec(output)?.[1]
      ?.toLowerCase() ?? null
  );
}

const decodeApiResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
    ),
    result: Schema.optional(Schema.Unknown),
  }),
);
const decodeSubdomain = Schema.decodeUnknownOption(Schema.Struct({ subdomain: Schema.String }));

interface ApiAnswer {
  readonly success: boolean;
  /** The first error's code, which is what wrangler decides on too. */
  readonly code: number | undefined;
  readonly subdomain: string | null;
  /** One line for the setup details. */
  readonly summary: string;
}

const callApi = Effect.fnUntraced(function* (
  token: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.fn.Return<ApiAnswer, WorkersDevSubdomainError, HttpClient.HttpClient> {
  const what = `${request.method} ${request.url.slice(API_BASE.length)}`;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(request.pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.acceptJson))
    .pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(
        () => new WorkersDevSubdomainError({ message: `${what}: Cloudflare did not answer.` }),
      ),
    );
  const json = yield* response.json.pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.option);
  const parsed = Option.flatMap(json, decodeApiResponse);
  if (Option.isNone(parsed)) {
    return yield* new WorkersDevSubdomainError({
      message: `${what}: Cloudflare answered ${response.status} without an API response.`,
    });
  }
  const { success, errors, result } = parsed.value;
  const first = errors?.[0];
  return {
    success,
    code: first?.code,
    subdomain: Option.getOrNull(Option.map(decodeSubdomain(result), (value) => value.subdomain)),
    summary:
      first === undefined
        ? `${what}: Cloudflare answered ${response.status}.`
        : `${what}: Cloudflare answered ${response.status}: ${first.message ?? "error"} [code: ${first.code}]`,
  };
});

/** `viewcode-` and six random lowercase letters or digits. */
const candidateName = Effect.gen(function* () {
  let suffix = "";
  for (let index = 0; index < NAME_SUFFIX_LENGTH; index += 1) {
    suffix +=
      NAME_ALPHABET[yield* Random.nextIntBetween(0, NAME_ALPHABET.length, { halfOpen: true })];
  }
  return `${NAME_PREFIX}${suffix}`;
});

/**
 * Registers a fresh `viewcode-xxxxxx` subdomain on the account and returns the
 * subdomain it now has. An account that already has one (made meanwhile in
 * the dashboard) keeps it.
 */
export const registerWorkersDevSubdomain = Effect.fn("registerWorkersDevSubdomain")(
  function* (input: {
    readonly accountId: string;
    readonly token: string;
  }): Effect.fn.Return<string, WorkersDevSubdomainError, HttpClient.HttpClient> {
    const fail = (message: string) => new WorkersDevSubdomainError({ message });
    const workers = `${API_BASE}/accounts/${encodeURIComponent(input.accountId)}/workers`;

    const current = yield* callApi(input.token, HttpClientRequest.get(`${workers}/subdomain`));
    if (current.success && current.subdomain !== null) return current.subdomain;
    if (current.code !== NO_SUBDOMAIN_REGISTERED) return yield* fail(current.summary);

    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
      const name = yield* candidateName;
      const check = yield* callApi(
        input.token,
        HttpClientRequest.get(`${workers}/subdomains/${name}`),
      );
      if (check.code === NAME_TAKEN) continue;
      if (!check.success && check.code !== NAME_AVAILABLE) return yield* fail(check.summary);
      const claim = yield* callApi(
        input.token,
        HttpClientRequest.put(`${workers}/subdomain`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ subdomain: name }),
        ),
      );
      if (claim.success) return claim.subdomain ?? name;
      // Someone else claimed it between the check and the claim.
      if (claim.code !== NAME_TAKEN) return yield* fail(claim.summary);
    }
    return yield* fail(`Every workers.dev name tried (${NAME_ATTEMPTS}) was already taken.`);
  },
);
