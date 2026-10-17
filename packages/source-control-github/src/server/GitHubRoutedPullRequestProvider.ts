import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as GitHubAccountRouting from "./GitHubAccountRouting.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";

export const make = Effect.gen(function* () {
  const provider = yield* GitHubPullRequestProvider.make;
  const api = yield* GitHubRest.GitHubRest;
  const sourceHost = yield* SourceControlHost.SourceControlHost;
  const accounts = yield* Cache.make({
    lookup: (key: string) => {
      const [host = "github.com", cwd = "."] = key.split("\u0000");
      return GitHubAccountRouting.signedInLogins({ host, cwd }).pipe(
        Effect.provideService(SourceControlHost.SourceControlHost, sourceHost),
      );
    },
    capacity: 32,
    timeToLive: "1 minute",
  });
  const route = yield* GitHubAccountRouting.make;
  const repositoryGroups = Effect.fn("GitHubRoutedPullRequestProvider.repositoryGroups")(function* (
    input: { readonly host: string; readonly cwd: string },
    repositories: ReadonlyArray<string>,
  ) {
    const entries = yield* Effect.forEach(
      [...new Set(repositories)],
      (repository) =>
        route({ ...input, repository }, api.credential(input.host)).pipe(
          Effect.map((credential) => ({ repository, credential })),
        ),
      { concurrency: 4 },
    );
    return [...Map.groupBy(entries, (entry) => entry.credential.fingerprint).values()];
  });
  const routeError = (error: import("./GitHubRequestPolicy.ts").GitHubApiError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("github"),
      operation: "routeIdentity",
      ...GitHubPullRequestProvider.gitHubProviderFailure(error),
      detail: error.message,
      cause: error,
    });
  const routed: PullRequestProviderApi = {
    ...provider,
    getRoutingIdentity: (input) =>
      route(input, provider.getRoutingIdentity!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    withVerifiedCredential: (input, use) =>
      route(
        input,
        provider.withVerifiedCredential!(input, (identity) => use(identity).pipe(Effect.result)),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
        Effect.flatMap(Effect.fromResult),
      ),
    getViewer: (input) =>
      route(input, provider.getViewer!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    listChangeRequests: (input) =>
      route(
        input,
        provider.getViewer({ cwd: input.cwd, host: input.host }).pipe(
          Effect.flatMap((viewer) =>
            provider.listChangeRequests({ ...input, viewer }).pipe(
              Effect.map((page) => ({
                ...page,
                items: page.items.map((item) => ({ ...item, viewerLogin: viewer })),
              })),
            ),
          ),
        ),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    listChangeRequestsAcross: (input) =>
      repositoryGroups(input, input.repositories).pipe(
        Effect.flatMap((groups) =>
          Effect.forEach(
            groups,
            (group) =>
              provider.getViewer({ cwd: input.cwd, host: input.host }).pipe(
                Effect.flatMap((viewer) =>
                  provider.listChangeRequestsAcross!({
                    ...input,
                    repositories: group.map((entry) => entry.repository),
                    viewer,
                  }).pipe(
                    Effect.map((page) => ({
                      ...page,
                      items: page.items.map((item) => ({ ...item, viewerLogin: viewer })),
                    })),
                  ),
                ),
                Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
                  host: input.host,
                  token: group[0]!.credential.token,
                  credentialFingerprint: group[0]!.credential.fingerprint,
                }),
              ),
            { concurrency: 4 },
          ),
        ),
        Effect.map((batches) => ({
          items: batches.flatMap((batch) => batch.items),
          truncated: batches.some((batch) => batch.truncated),
        })),
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    listChangeRequestStats: (input) =>
      repositoryGroups(
        input,
        input.changeRequests.map((entry) => entry.repository),
      ).pipe(
        Effect.flatMap((groups) =>
          Effect.forEach(
            groups,
            (group) =>
              provider.listChangeRequestStats!({
                ...input,
                changeRequests: input.changeRequests.filter((entry) =>
                  group.some((route) => route.repository === entry.repository),
                ),
              }).pipe(
                Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
                  host: input.host,
                  token: group[0]!.credential.token,
                  credentialFingerprint: group[0]!.credential.fingerprint,
                }),
              ),
            { concurrency: 4 },
          ),
        ),
        Effect.map((batches) => batches.flat()),
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestSummary: (input) =>
      route(input, provider.getChangeRequestSummary!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestStack: (input) =>
      route(input, provider.getChangeRequestStack!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestWatchFingerprint: (input) =>
      route(input, provider.getChangeRequestWatchFingerprint!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestPreview: (input) =>
      route(input, provider.getChangeRequestPreview!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestChecks: (input) =>
      route(input, provider.getChangeRequestChecks!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequest: (input) =>
      route(
        input,
        provider
          .getChangeRequest(input)
          .pipe(
            Effect.flatMap((detail) =>
              Cache.get(accounts, `${input.host}\u0000${input.cwd}`).pipe(
                Effect.map((viewerLogins) => ({ ...detail, viewerLogins })),
              ),
            ),
          ),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getChangeRequestActivity: (input) =>
      route(input, provider.getChangeRequestActivity!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getReviewThreadComments: (input) =>
      route(input, provider.getReviewThreadComments!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getViewerPermissions: (input) =>
      route(input, provider.getViewerPermissions!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getDiff: (input) =>
      route(input, provider.getDiff!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getDiffFileContents: (input) =>
      route(input, provider.getDiffFileContents!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    getFilesViewed: (input) =>
      route(input, provider.getFilesViewed!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    setFilesViewed: (input) =>
      route(input, provider.setFilesViewed!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    listReviewerCandidates: (input) =>
      route(input, provider.listReviewerCandidates!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    setReviewerRequest: (input) =>
      route(input, provider.setReviewerRequest!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    listLabelCandidates: (input) =>
      route(input, provider.listLabelCandidates!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    setLabels: (input) =>
      route(input, provider.setLabels!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    runAction: (input) =>
      route(input, provider.runAction!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    updateChangeRequest: (input) =>
      route(input, provider.updateChangeRequest!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    comment: (input) =>
      route(input, provider.comment!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    updateComment: (input) =>
      route(input, provider.updateComment!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    submitReview: (input) =>
      route(input, provider.submitReview!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    replyToThread: (input) =>
      route(input, provider.replyToThread!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    setReaction: (input) =>
      route(input, provider.setReaction!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
    setThreadResolution: (input) =>
      route(input, provider.setThreadResolution!(input)).pipe(
        Effect.mapError((error) =>
          error._tag === "PullRequestProviderError" ? error : routeError(error),
        ),
      ),
  };
  return routed;
});
