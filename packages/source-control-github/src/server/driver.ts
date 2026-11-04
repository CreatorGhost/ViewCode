import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as GitHubPullRequestProvider from "./GitHubRoutedPullRequestProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitHubRoutedSourceControlProvider from "./GitHubRoutedSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("github"),
  make: Effect.all({
    sourceControl: GitHubRoutedSourceControlProvider.make,
    discovery: GitHubSourceControlProvider.makeDiscovery,
    pullRequests: GitHubPullRequestProvider.make,
  }),
});
