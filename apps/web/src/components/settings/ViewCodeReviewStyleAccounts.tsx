import type { EnvironmentId, SourceControlProviderAuth } from "@t3tools/contracts";
import { PullRequestReviewStyleAccounts } from "./PullRequestReviewStyleSettings";
import { viewCodeReviewStyleAccounts } from "./viewcodeReviewStyleAccounts.logic";

export function ViewCodeReviewStyleAccounts({
  environmentId,
  auth,
}: {
  environmentId: EnvironmentId;
  auth: SourceControlProviderAuth;
}) {
  return viewCodeReviewStyleAccounts(auth).map(({ host, logins }) => (
    <section key={host} className="grid gap-3" aria-label={`Review style on ${host}`}>
      <h4 className="text-xs font-medium text-muted-foreground">Review style · {host}</h4>
      <PullRequestReviewStyleAccounts environmentId={environmentId} host={host} logins={logins} />
    </section>
  ));
}
