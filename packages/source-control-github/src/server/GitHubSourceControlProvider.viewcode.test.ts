import * as HostProcess from "@t3tools/shared/HostProcess";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// A GitHub Enterprise Server whose host name has no "github" label (a company's own forge)
// reads as an unknown remote. ViewCode claims it as GitHub when `gh` is signed in to that host,
// comparing hosts without the port an SSH clone URL carries, since `gh` records the bare host.
const SIGNED_IN = new Set(["git.corp.example"]);

const refine = (remoteUrl: string) =>
  Effect.gen(function* () {
    const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
    assert.isNotNull(provider);
    const discovery = yield* GitHubSourceControlProvider.makeDiscovery;
    return yield* discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: { provider: provider!, remoteName: "origin", remoteUrl },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubRest.GitHubRest, {
          rest: () => Effect.die("no REST call expected"),
          credential: (host) =>
            SIGNED_IN.has(host)
              ? Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` })
              : Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
        }),
        TestSourceControlHost.layer({}),
      ),
    ),
    Effect.provideService(HostProcess.Environment, {}),
  );

it.effect("claims an Enterprise host that gh is signed in to", () =>
  Effect.gen(function* () {
    const claimed = yield* refine("git@git.corp.example:team/app.git");
    assert.strictEqual(claimed?.kind, "github");
    assert.strictEqual(claimed?.name, "GitHub Self-Hosted");
  }),
);

it.effect("matches the signed-in host when the clone URL carries an SSH port", () =>
  Effect.gen(function* () {
    const claimed = yield* refine("ssh://git@Git.Corp.Example:2222/team/app.git");
    assert.strictEqual(claimed?.kind, "github");
  }),
);

it.effect("leaves a host gh is not signed in to unclaimed", () =>
  Effect.gen(function* () {
    assert.isNull(yield* refine("git@git.other.example:team/app.git"));
  }),
);
