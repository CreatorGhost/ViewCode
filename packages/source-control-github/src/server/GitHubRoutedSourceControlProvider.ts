import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as GitHubSshAlias from "./GitHubSshAlias.ts";
import * as GitHubAccountRouting from "./GitHubAccountRouting.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import {
  gitHubApiHostForRemote,
  parseGitHubRepositorySelector,
  parsePullRequestReference,
} from "./gitHubRepositoryResolution.ts";

export const make = Effect.gen(function* () {
  const provider = yield* GitHubSourceControlProvider.make;
  const route = yield* GitHubAccountRouting.make;
  const canonicalRemote = yield* GitHubSshAlias.make;
  const routed = <
    A,
    I extends {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
      readonly reference?: string;
    },
  >(
    original: I,
    operation: string,
    use: (input: I) => Effect.Effect<A, SourceControlProviderError>,
  ) =>
    Effect.gen(function* () {
      const context = original.context;
      const remote =
        context === undefined ? undefined : yield* canonicalRemote(context.remoteUrl, original.cwd);
      const apiHost = remote === undefined ? undefined : gitHubApiHostForRemote(remote);
      const input =
        context === undefined || remote === undefined || apiHost === null || apiHost === undefined
          ? original
          : {
              ...original,
              context: {
                ...context,
                remoteUrl: remote,
                provider: { ...context.provider, baseUrl: `https://${apiHost}` },
              },
            };
      const effect = use(input);
      const host =
        remote === undefined ? "github.com" : (gitHubApiHostForRemote(remote) ?? "github.com");
      const reference =
        input.reference === undefined ? null : parsePullRequestReference(input.reference);
      const normalized = remote === undefined ? null : normalizeGitRemoteUrl(remote);
      const locator =
        reference?.kind === "url"
          ? reference.locator
          : input.repository === undefined
            ? normalized === null
              ? null
              : parseGitHubRepositorySelector(normalized.slice(normalized.indexOf("/") + 1), host)
            : parseGitHubRepositorySelector(input.repository, host);
      if (locator === null) return yield* effect;
      return yield* route(
        { cwd: input.cwd, host: locator.host, repository: `${locator.owner}/${locator.name}` },
        effect,
      ).pipe(
        Effect.mapError((cause) =>
          cause._tag === "SourceControlProviderError"
            ? cause
            : new SourceControlProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation,
                cwd: input.cwd,
                detail: cause.message,
                cause,
              }),
        ),
      );
    });
  return SourceControlProvider.SourceControlProvider.of({
    ...provider,
    listChangeRequests: (input) => routed(input, "listChangeRequests", provider.listChangeRequests),
    getChangeRequest: (input) => routed(input, "getChangeRequest", provider.getChangeRequest),
    createChangeRequest: (input) =>
      routed(input, "createChangeRequest", provider.createChangeRequest),
    getRepositoryCloneUrls: (input) =>
      routed(input, "getRepositoryCloneUrls", provider.getRepositoryCloneUrls),
    getDefaultBranch: (input) => routed(input, "getDefaultBranch", provider.getDefaultBranch),
    checkoutChangeRequest: (input) =>
      routed(input, "checkoutChangeRequest", provider.checkoutChangeRequest),
  });
});
