import type { SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";

/** API discovery keeps accounts per host; styles keep the same host/account boundary. */
export function viewCodeReviewStyleAccounts(auth: SourceControlProviderAuth) {
  const hosts = new Map<string, { logins: Map<string, string>; active: string | undefined }>();
  for (const entry of auth.accounts ?? []) {
    if (!entry.authenticated) continue;
    const host = entry.host.toLowerCase();
    const group = hosts.get(host) ?? { logins: new Map<string, string>(), active: undefined };
    group.logins.set(entry.account.toLowerCase(), entry.account);
    if (entry.active) group.active = entry.account.toLowerCase();
    hosts.set(host, group);
  }
  if (auth.status === "authenticated" && Option.isSome(auth.account)) {
    const host = Option.getOrElse(auth.host, () => "github.com").toLowerCase();
    const group = hosts.get(host) ?? { logins: new Map<string, string>(), active: undefined };
    group.logins.set(auth.account.value.toLowerCase(), auth.account.value);
    group.active = auth.account.value.toLowerCase();
    hosts.set(host, group);
  }
  return [...hosts].map(([host, group]) => ({
    host,
    logins: [...group.logins]
      .toSorted(([left], [right]) => Number(right === group.active) - Number(left === group.active))
      .map(([, login]) => login),
  }));
}
