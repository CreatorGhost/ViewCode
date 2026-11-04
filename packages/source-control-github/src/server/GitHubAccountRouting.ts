import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";

type Target = {
  readonly host?: string | undefined;
  readonly repository?: string | undefined;
  readonly cwd: string;
};

export const signedInLogins = Effect.fn("GitHubAccountRouting.signedInLogins")(function* (input: {
  readonly host: string;
  readonly cwd: string;
}) {
  const sourceHost = yield* SourceControlHost.SourceControlHost;
  return yield* sourceHost.process
    .run({
      operation: "GitHubAccountRouting.accounts",
      command: "gh",
      args: ["auth", "status", "--hostname", input.host, "--json", "hosts"],
      cwd: input.cwd,
      env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.map((output) =>
        parseGitHubAuthStatus(output.stdout)
          .accounts.filter(
            (entry) =>
              entry.host === input.host &&
              entry.authenticated &&
              entry.environmentVariable === null,
          )
          .map((entry) => entry.account),
      ),
      Effect.orElseSucceed(() => []),
    );
});

/**
 * Resolve the repository's reader before running its operation. Only read-only visibility probes
 * try other accounts; a mutation is sent once, with one pinned credential for every API call.
 */
export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const api = yield* GitHubRest.GitHubRest;
  const host = yield* SourceControlHost.SourceControlHost;
  const routes = new Map<
    string,
    { readonly account: string | undefined; readonly until: number }
  >();
  const gate = yield* Semaphore.make(1);

  const select = Effect.fn("GitHubAccountRouting.select")(function* (input: Target) {
    const hostname = GitHubRequestPolicy.normalizeHost(input.host ?? "github.com");
    const initial = yield* credentials.get(hostname);
    const repository = input.repository?.trim().replace(/\.git$/u, "");
    if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) return initial;
    // An explicitly supplied token defines the account boundary for the host.
    if (initial.source !== "gh") return initial;
    const key = `${initial.fingerprint}\u0000${repository.toLowerCase()}`;
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = routes.get(key);
        if (cached !== undefined && cached.until > now) {
          return cached.account === undefined
            ? initial
            : yield* credentials.get(hostname, cached.account);
        }
        const probe = (credential: GitHubCredentials.GitHubCredential) =>
          api
            .rest({
              host: hostname,
              operation: "routeRepositoryAccount",
              path: `repos/${repository.split("/").map(encodeURIComponent).join("/")}`,
              maxResponseBytes: 64 * 1024,
            })
            .pipe(
              Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
                host: hostname,
                token: credential.token,
                credentialFingerprint: credential.fingerprint,
              }),
            );
        const remember = (account: string | undefined, duration: number) => {
          if (routes.size >= 512) routes.delete(routes.keys().next().value!);
          routes.set(key, { account, until: now + duration });
        };
        const first = yield* probe(initial).pipe(Effect.result);
        if (first._tag === "Success") {
          remember(undefined, 10 * 60_000);
          return initial;
        }
        const error = first.failure;
        if (
          error._tag !== "GitHubApiNotFoundError" &&
          error._tag !== "GitHubApiAuthenticationError" &&
          !(error._tag === "GitHubApiResponseError" && error.status === 403)
        )
          return yield* error;
        const accounts = yield* signedInLogins({ host: hostname, cwd: input.cwd }).pipe(
          Effect.provideService(SourceControlHost.SourceControlHost, host),
        );
        for (const account of accounts) {
          const candidate = yield* credentials.get(hostname, account).pipe(Effect.option);
          if (Option.isNone(candidate) || candidate.value.fingerprint === initial.fingerprint)
            continue;
          const answer = yield* probe(candidate.value).pipe(Effect.result);
          if (answer._tag === "Success") {
            remember(account, 10 * 60_000);
            return candidate.value;
          }
          const failure = answer.failure;
          if (
            failure._tag !== "GitHubApiNotFoundError" &&
            failure._tag !== "GitHubApiAuthenticationError" &&
            !(failure._tag === "GitHubApiResponseError" && failure.status === 403)
          )
            return yield* failure;
        }
        // Do not cache a transient visibility failure for ten minutes.
        remember(undefined, 30_000);
        return yield* error;
      }),
    );
  });

  return <A, E, R>(input: Target, operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
      if (pinned !== null || input.repository === undefined) return yield* operation;
      const credential = yield* select(input);
      return yield* operation.pipe(
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: credential.host,
          token: credential.token,
          credentialFingerprint: credential.fingerprint,
        }),
      );
    });
});
